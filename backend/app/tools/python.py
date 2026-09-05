"""Code execution, as a tool.

This exists for a reliability reason, not an efficiency one. If a step is
"calculate 17.5% of 843", a reasoning model producing the number in prose is
guessing at arithmetic; running two lines of Python gives the exact result.
Every number that ends up in a generated deliverable should come from here or
from a cited document, never from a model's free text.

The tool is marked high risk and everything about the call is logged. It does
not require human approval, because the sandbox -- no network, read-only root,
capped memory and CPU, hard timeout -- is what makes it safe, and an approval
prompt on every arithmetic step would train the operator to click through.
"""

from __future__ import annotations

from typing import ClassVar

from app.core.dependencies import record_audit
from app.sandbox.base import SandboxRequest
from app.sandbox.docker_runner import docker_sandbox
from app.tools import workspace
from app.tools.base import ToolContext, ToolResult

MAX_TIMEOUT_S = 60
DEFAULT_TIMEOUT_S = 30
MAX_OUTPUT_CHARS = 20_000


class PythonExecuteTool:
    name = "python.execute"
    description = (
        "Run a short Python program in an isolated container with no network "
        "access and print its result to stdout. Use this for every "
        "calculation, table manipulation or data check rather than working "
        "the answer out in prose. Only the standard library is available. "
        "Files named in 'input_files' are copied in from the task workspace, "
        "and anything the program writes is copied back out."
    )
    risk_level = "high"
    requires_approval = False
    input_schema: ClassVar[dict] = {
        "type": "object",
        "properties": {
            "code": {"type": "string"},
            "input_files": {
                "type": "array",
                "description": "Workspace filenames to make available.",
            },
            "timeout_s": {"type": "integer"},
        },
        "required": ["code"],
    }

    def execute(self, args: dict, context: ToolContext) -> ToolResult:
        code = str(args["code"])
        if not code.strip():
            return ToolResult.failed("No code to run.")

        timeout = max(
            1, min(int(args.get("timeout_s", DEFAULT_TIMEOUT_S)), MAX_TIMEOUT_S)
        )

        files: dict[str, bytes] = {}
        for name in args.get("input_files") or []:
            try:
                files[str(name)] = workspace.read(context.task_id, str(name))
            except workspace.WorkspaceError as exc:
                return ToolResult.failed(str(exc))

        # Recorded before the run, not after: if the sandbox hangs or the
        # process dies mid-execution, the ledger still shows that code was
        # submitted. An event written only on success would hide exactly the
        # runs worth investigating.
        record_audit(
            event_type="SANDBOX_STARTED",
            action="sandbox:execute",
            component="sandbox",
            user_id=context.user_id,
            task_id=context.task_id,
            metadata={
                "runner": docker_sandbox.name,
                "language": "python",
                "code_bytes": len(code),
                "input_files": sorted(files),
                "timeout_s": timeout,
                "network": "none",
            },
        )

        result = docker_sandbox.run(
            SandboxRequest(code=code, files=files, timeout_s=timeout)
        )

        if result.status == "unavailable":
            # The distinction matters to the agent: the code did not fail, it
            # never ran. Treating this as a failed calculation would let it
            # conclude something about arithmetic it never performed.
            return ToolResult.failed(
                f"The code sandbox is unavailable, so nothing was run: "
                f"{result.detail}"
            )

        # Anything the program wrote is kept, so a later step can pick it up.
        written: list[str] = []
        for name, payload in result.produced.items():
            try:
                workspace.write(context.task_id, name, payload)
                written.append(name)
            except workspace.WorkspaceError:
                continue

        return ToolResult(
            ok=result.succeeded,
            data={
                "exit_code": result.exit_code,
                "stdout": result.stdout[:MAX_OUTPUT_CHARS],
                "stderr": result.stderr[:MAX_OUTPUT_CHARS],
                "duration_ms": result.duration_ms,
                "status": result.status,
                "files_written": sorted(written),
            },
            error=(
                ""
                if result.succeeded
                else result.detail or f"exited {result.exit_code}"
            ),
            detail=f"{result.status} in {result.duration_ms} ms",
        )
