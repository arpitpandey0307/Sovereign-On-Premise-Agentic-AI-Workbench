"""Live GPU state, so routing reacts to the machine instead of assuming it.

The spec lists GPU-load-aware routing as a later phase, but querying free VRAM
costs one subprocess call and is the difference between a router that thinks a
model fits and one that knows. Results are cached briefly -- a routing decision
should not shell out on every candidate.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import time
from dataclasses import dataclass, field

logger = logging.getLogger("workbench.hardware")

CACHE_TTL_SECONDS = 2.0

# What CUDA itself costs before any weights load, plus KV cache headroom. The
# spec warns an 8 GB card gets tight once these are counted, so the router
# reserves them rather than discovering the shortfall at load time.
CUDA_OVERHEAD_GB = 0.6
KV_CACHE_HEADROOM_GB = 0.8


@dataclass
class GpuState:
    present: bool = False
    name: str = "none"
    total_vram_gb: float = 0.0
    used_vram_gb: float = 0.0
    utilisation_pct: float = 0.0
    detail: str = ""
    resident_models: list[str] = field(default_factory=list)
    resident_vram_gb: float = 0.0

    @property
    def free_vram_gb(self) -> float:
        return max(0.0, self.total_vram_gb - self.used_vram_gb)

    @property
    def usable_vram_gb(self) -> float:
        """Free VRAM minus the overhead a freshly loaded model will incur."""
        if not self.present:
            return 0.0
        return max(0.0, self.free_vram_gb - CUDA_OVERHEAD_GB - KV_CACHE_HEADROOM_GB)

    @property
    def pressure(self) -> float:
        """0.0 when the card is idle, 1.0 when it is full."""
        if not self.present or self.total_vram_gb <= 0:
            return 1.0
        return min(1.0, self.used_vram_gb / self.total_vram_gb)


class HardwareProbe:
    def __init__(self) -> None:
        self._cached: GpuState | None = None
        self._cached_at = 0.0

    def state(self, *, refresh: bool = False) -> GpuState:
        now = time.monotonic()
        if (
            not refresh
            and self._cached is not None
            and now - self._cached_at < CACHE_TTL_SECONDS
        ):
            return self._cached

        self._cached = self._probe()
        self._cached_at = now
        return self._cached

    def _probe(self) -> GpuState:
        if shutil.which("nvidia-smi") is None:
            return GpuState(detail="nvidia-smi not present; assuming CPU inference")

        try:
            result = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=name,memory.total,memory.used,utilization.gpu",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=4,
                check=True,
            )
        except (subprocess.SubprocessError, OSError) as exc:
            logger.warning("GPU probe failed: %s", exc)
            return GpuState(detail=f"probe failed: {type(exc).__name__}")

        line = result.stdout.strip().splitlines()
        if not line:
            return GpuState(detail="nvidia-smi returned no device")

        try:
            name, total_mib, used_mib, util = (
                part.strip() for part in line[0].split(",")
            )
            return GpuState(
                present=True,
                name=name,
                total_vram_gb=round(float(total_mib) / 1024, 2),
                used_vram_gb=round(float(used_mib) / 1024, 2),
                utilisation_pct=float(util),
                detail="ok",
            )
        except ValueError as exc:
            logger.warning("could not parse nvidia-smi output: %s", exc)
            return GpuState(detail="unparseable nvidia-smi output")


hardware = HardwareProbe()
