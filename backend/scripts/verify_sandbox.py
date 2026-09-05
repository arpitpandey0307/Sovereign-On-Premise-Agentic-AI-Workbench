"""Verify the code sandbox actually confines what it claims to.

The sandbox is the most dangerous capability in the system: it runs code a
model wrote. Its safety rests on claims -- no network, read-only root, capped
memory, hard timeout -- and a claim that is only asserted in a docstring is
not a control. This runs code that *tries* to break each one and checks it
cannot.

    docker pull python:3.12-slim
    python scripts/verify_sandbox.py

The network check is the one that matters most for this project. If code in
the sandbox can open a socket, the sovereignty claim is false: a model could
write code that exfiltrates the confidential documents it was reasoning over.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_tmp = Path(tempfile.mkdtemp(prefix="verify-sandbox-"))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(_tmp / 's.db').as_posix()}")
os.environ["STORAGE_ROOT"] = (_tmp / "storage").as_posix()
os.environ["DEBUG"] = "false"

from app.sandbox.base import SandboxRequest  # noqa: E402
from app.sandbox.docker_runner import docker_sandbox  # noqa: E402

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}"
          f"{(' -- ' + detail) if detail else ''}")
    if not condition:
        failures.append(label)


def run(code: str, *, expect_run: bool = True, **kwargs):
    """Run a snippet, insisting it actually executed unless told otherwise.

    Without this, every confinement check passes vacuously the moment the
    sandbox stops working: code that never ran also never reached the network.
    That is exactly what happened on the first run of this script.
    """
    result = docker_sandbox.run(SandboxRequest(code=code, **kwargs))
    if expect_run and result.status not in {"ok", "timeout"}:
        check(
            "the snippet actually ran",
            False,
            f"status={result.status}: {result.detail[:160]}",
        )
    return result


def main() -> int:
    print("=== 0. the sandbox is available ===")
    available, detail = docker_sandbox.available()
    check("Docker and the sandbox image are ready", available, detail)
    if not available:
        print("\nRun: docker pull python:3.12-slim")
        return 1

    print("\n=== 1. ordinary code runs and returns its output ===")
    result = run("print(sum(range(1, 101)))")
    check("exit code 0", result.exit_code == 0, result.stderr[:200])
    check("stdout captured", result.stdout.strip() == "5050", result.stdout[:80])
    check("duration recorded", result.duration_ms > 0, f"{result.duration_ms} ms")
    check("status is ok", result.status == "ok", result.status)

    print("\n=== 2. failing code is reported, not hidden ===")
    result = run("raise ValueError('deliberate')")
    check("non-zero exit", result.exit_code != 0, str(result.exit_code))
    check("traceback on stderr", "ValueError" in result.stderr, result.stderr[:120])
    check("did not succeed", not result.succeeded)

    print("\n=== 3. NO NETWORK -- the sovereignty claim ===")
    result = run(
        "import socket\n"
        "socket.setdefaulttimeout(4)\n"
        "try:\n"
        "    socket.create_connection(('1.1.1.1', 53))\n"
        "    print('NETWORK REACHABLE')\n"
        "except Exception as exc:\n"
        "    print('blocked:', type(exc).__name__)\n",
        timeout_s=20,
    )
    check(
        "code cannot open an outbound socket",
        "NETWORK REACHABLE" not in result.stdout,
        result.stdout.strip()[:120],
    )

    result = run(
        "import socket\n"
        "try:\n"
        "    print('resolved', socket.gethostbyname('example.com'))\n"
        "except Exception as exc:\n"
        "    print('dns blocked:', type(exc).__name__)\n",
        timeout_s=20,
    )
    check(
        "code cannot resolve a hostname",
        "resolved" not in result.stdout,
        result.stdout.strip()[:120],
    )

    print("\n=== 4. the host filesystem is not reachable ===")
    result = run(
        "import os\n"
        "try:\n"
        "    open('/etc/shadow').read()\n"
        "    print('READ SHADOW')\n"
        "except Exception as exc:\n"
        "    print('denied:', type(exc).__name__)\n"
        "try:\n"
        "    open('/etc/evil', 'w').write('x')\n"
        "    print('WROTE TO ROOT')\n"
        "except Exception as exc:\n"
        "    print('root read-only:', type(exc).__name__)\n"
        "print('cwd listing:', sorted(os.listdir('.')))\n"
    )
    check("cannot read host secrets", "READ SHADOW" not in result.stdout)
    check(
        "root filesystem is read-only",
        "WROTE TO ROOT" not in result.stdout,
        result.stdout.strip()[-160:],
    )

    print("\n=== 5. it runs unprivileged ===")
    result = run("import os; print('uid', os.getuid())")
    check("not running as root", "uid 0" not in result.stdout, result.stdout.strip())

    print("\n=== 6. a hard timeout kills a runaway ===")
    result = run("while True:\n    pass\n", timeout_s=5)
    check("timed out rather than hanging", result.status == "timeout", result.status)
    check("said so", "killed" in result.detail, result.detail)

    print("\n=== 7. memory is capped ===")
    result = run(
        "x = bytearray(1024 * 1024 * 400)\nprint('ALLOCATED', len(x))\n",
        memory_mb=128,
        timeout_s=30,
    )
    check(
        "a large allocation does not succeed",
        "ALLOCATED" not in result.stdout,
        f"exit {result.exit_code}, status {result.status}",
    )

    print("\n=== 8. files go in and come back out ===")
    result = run(
        "rows = open('readings.csv').read().strip().splitlines()\n"
        "total = sum(float(line.split(',')[1]) for line in rows[1:])\n"
        "print('total', total)\n"
        "open('result.txt', 'w').write(str(total))\n",
        files={"readings.csv": b"tag,value\nV-103,4.2\nV-104,3.8\n"},
    )
    check("input file was readable", "total 8.0" in result.stdout, result.stdout[:120])
    check("output file came back", "result.txt" in result.produced,
          str(sorted(result.produced)))
    check(
        "and the seeded files are not returned as output",
        "readings.csv" not in result.produced and "main.py" not in result.produced,
    )

    print("\n=== 9. nothing persists between runs ===")
    run("open('leak.txt', 'w').write('secret')")
    result = run(
        "import os\nprint('leak.txt' in os.listdir('.'))"
    )
    check(
        "a file written by one run is gone in the next",
        result.stdout.strip() == "False",
        result.stdout.strip(),
    )

    print("\n" + "=" * 62)
    if failures:
        print(f"FAILURES ({len(failures)}):")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("Every check passed. The sandbox confines what it claims to.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
