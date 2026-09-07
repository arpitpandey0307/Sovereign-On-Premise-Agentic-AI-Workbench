"""Build the operating documents the downloaded datasets do not provide.

The public datasets in `dataset corpus/` supply real, on-topic material -- an
MRPL annual report, a refinery inspection report, CSB incident investigations,
and 500 P&ID drawings. What they cannot supply is a *plant*: documents that
refer to the same equipment as each other, carry sensitivity markings, and sit
at several classification levels. Without that there is no equipment graph, no
clearance boundary to demonstrate, and nothing that triggers the approval gate.

So this writes a small operating corpus for one imaginary unit. Every file it
produces says, in its own text, that it is generated demonstration material --
a synthetic document that reads as a genuine record would be the one thing this
product must never put in front of an auditor.

    python scripts/build_demo_corpus.py [--out DIR]

The equipment tags follow ISA-5.1 and are drawn from a single register, so the
same pump appears in the SOP, the inspection report, the HAZOP and the
datasheet -- which is what gives `GET /knowledge/equipment/{tag}` something to
traverse.
"""

from __future__ import annotations

import argparse
import csv
import random
from datetime import date, timedelta
from pathlib import Path

BANNER = (
    "GENERATED DEMONSTRATION DOCUMENT — synthetic content for the Sovereign AI\n"
    "Workbench prototype. Not a record of any real plant, equipment or incident.\n"
)

# One unit's register. Prefixes are the ISA-5.1 ones the entity extractor maps,
# so each tag resolves to a real equipment type rather than an unknown node.
EQUIPMENT = [
    ("P-101", "pump", "Crude charge pump A"),
    ("P-102", "pump", "Crude charge pump B (standby)"),
    ("E-201", "heat_exchanger", "Crude/residue preheat exchanger"),
    ("C-301", "column", "Atmospheric distillation column"),
    ("V-103", "valve", "P-101 suction isolation valve"),
    ("V-104", "valve", "P-102 suction isolation valve"),
    ("PSV-107", "relief_valve", "C-301 overhead relief valve"),
    ("TK-401", "tank", "Intermediate residue storage tank"),
    ("K-102", "compressor", "Overhead vapour compressor"),
    ("PT-2201", "pressure_transmitter", "P-101 discharge pressure"),
    ("TT-2202", "temperature_transmitter", "E-201 shell outlet temperature"),
    ("FIC-305", "flow_controller", "C-301 reflux flow controller"),
    ("LIC-402", "level_controller", "TK-401 level controller"),
    ("R-501", "reactor", "Hydrotreater reactor"),
]

TAGS = [tag for tag, _, _ in EQUIPMENT]


def _header(title: str, doc_no: str, marking: str) -> str:
    return (
        f"{BANNER}\n"
        f"{marking}\n\n"
        f"{title}\n"
        f"Document number: {doc_no}\n"
        f"Unit: CDU-3, Mangalore Refinery (illustrative)\n"
        f"Revision: 3    Issued: {date(2026, 3, 14).isoformat()}\n"
        f"{'=' * 72}\n"
    )


def sop_isolation(out: Path) -> None:
    """The document the hero flow is demonstrated against."""
    text = _header(
        "Standard Operating Procedure — Pump Isolation and Lock-Out",
        "SOP-204",
        "INTERNAL USE ONLY",
    ) + """
1. PURPOSE

   This procedure covers isolation of the crude charge pumps P-101 and P-102
   on CDU-3 for maintenance, and the lock-out that must be in place before any
   flange is broken.

2. SCOPE

   Applies to P-101, P-102 and their associated suction valves V-103 and V-104.
   It does not cover the hydrotreater reactor R-501, which has its own
   procedure under SOP-311.

3. PERMITS

   3.1 A hot work permit must be signed before any welding or grinding.
   3.2 A confined space entry permit is required for work inside TK-401.

4. ISOLATION

   4.1 Permits
       Confirm the maintenance permit names the pump being isolated. A permit
       naming P-101 does not authorise work on P-102.

   4.2 Isolation
       Close suction valve V-103 and apply a lock-out tag. Confirm zero
       pressure at PT-2201 before breaking any flange. Where the standby pump
       P-102 is to remain in service, verify V-104 is open and that FIC-305
       holds reflux flow within 5% of setpoint.

   4.3 Draining
       Drain to the closed system. Do not drain to the open pit while E-201 is
       above 60 degrees Celsius, as measured at TT-2202.

5. RELIEF PROTECTION

   PSV-107 protects the C-301 overhead circuit and must not be isolated while
   the column is in service. Any request to gag PSV-107 requires the unit
   manager's written approval.

6. RESTORATION

   6.1 Remove lock-out tags in the reverse order they were applied.
   6.2 Confirm PT-2201 returns to normal operating pressure within 10 minutes.
   6.3 Log the restoration against this SOP number in the shift log.
"""
    (out / "SOP-204_pump_isolation.txt").write_text(text, encoding="utf-8")


def sop_relief(out: Path) -> None:
    text = _header(
        "Standard Operating Procedure — Relief Valve Testing",
        "SOP-311",
        "INTERNAL USE ONLY",
    ) + """
1. PURPOSE

   Bench testing and reinstatement of relief valves on CDU-3, principally
   PSV-107 on the C-301 overhead.

2. FREQUENCY

   Every 36 months, or immediately following any lift event recorded against
   PSV-107.

3. PROCEDURE

   3.1 Isolate C-301 overhead in accordance with SOP-204.
   3.2 Confirm K-102 is shut down and depressured before removing PSV-107.
   3.3 Record the as-found set pressure. A drift greater than 3% of the design
       set pressure is reportable to the inspection engineer.
   3.4 Reinstate and witness the seal. LIC-402 must be in manual while TK-401
       receives the displaced inventory.

4. RECORDS

   Test certificates are retained for the life of the valve and referenced in
   the equipment datasheet for PSV-107.
"""
    (out / "SOP-311_relief_valve_testing.txt").write_text(text, encoding="utf-8")


def inspection_report(out: Path) -> None:
    text = _header(
        "Inspection Report — CDU-3 Rotating Equipment",
        "INS-2026-018",
        "CONFIDENTIAL",
    ) + """
1. SCOPE OF INSPECTION

   Routine external and vibration inspection of P-101, P-102 and K-102, with
   thickness survey of the E-201 shell.

2. FINDINGS

   2.1 P-101 — Mechanical seal weeping at approximately 3 drops per minute.
       Discharge pressure at PT-2201 is 4% below the design curve at rated
       flow. Recommend seal replacement at the next opportunity; isolate per
       SOP-204.

   2.2 P-102 — Satisfactory. Standby availability confirmed. V-104 stroked
       and free.

   2.3 K-102 — Vibration within limits. Second stage discharge temperature
       trending 6 degrees above the same period last year.

   2.4 E-201 — Minimum measured wall thickness 8.1 mm against a retirement
       limit of 6.4 mm. Next survey due in 24 months. TT-2202 calibration
       verified.

   2.5 PSV-107 — Due for bench test in 4 months under SOP-311.

3. RECOMMENDATIONS

   3.1 Replace the P-101 mechanical seal within 90 days.
   3.2 Trend K-102 second stage temperature weekly.
   3.3 No action required on C-301 or TK-401 arising from this inspection.
"""
    (out / "INS-2026-018_rotating_equipment.txt").write_text(text, encoding="utf-8")


def hazop(out: Path) -> None:
    text = _header(
        "HAZOP Study Worksheet — CDU-3 Crude Charge Circuit",
        "HAZ-CDU3-07",
        "HAZOP",
    ) + """
NODE 1 — Crude charge from tankage to E-201 via P-101 / P-102

  Deviation: NO FLOW
    Cause        Both P-101 and P-102 tripped, or V-103 and V-104 closed
                 together in error.
    Consequence  Loss of charge to C-301; column upset; possible dry running
                 of the reflux circuit under FIC-305.
    Safeguard    Low flow alarm; standby pump auto-start; operator response
                 per SOP-204.
    Action       Confirm auto-start test frequency. Owner: unit manager.

  Deviation: HIGH PRESSURE
    Cause        Discharge blocked in against a closed valve.
    Consequence  Seal failure on P-101; hydrocarbon release at grade.
    Safeguard    PT-2201 high alarm; PSV-107 protects the downstream circuit.
    Action       Verify PT-2201 alarm setpoint against the datasheet.

NODE 2 — C-301 overhead to K-102

  Deviation: HIGH TEMPERATURE
    Cause        Loss of cooling; E-201 fouling.
    Consequence  K-102 discharge temperature exceeds design; potential trip.
    Safeguard    TT-2202 high alarm; compressor trip on discharge temperature.
    Action       Review E-201 cleaning interval.

NODE 3 — Residue to TK-401

  Deviation: HIGH LEVEL
    Cause        LIC-402 failure in the closed position.
    Consequence  Tank overfill; environmental release.
    Safeguard    Independent high-high level switch; operator rounds.
    Action       Prove the high-high switch at the next shutdown.
"""
    (out / "HAZ-CDU3-07_hazop_worksheet.txt").write_text(text, encoding="utf-8")


def datasheets(out: Path) -> None:
    lines = [BANNER, "STRICTLY CONFIDENTIAL", "", "Equipment Datasheet Register — CDU-3", ""]
    lines.append(
        "This register carries commercially sensitive vendor pricing and is "
        "restricted to unit management."
    )
    lines.append("")
    for tag, kind, description in EQUIPMENT:
        lines.append(f"{tag}  ({kind.replace('_', ' ')})")
        lines.append(f"    Service       : {description}")
        lines.append(f"    Design code   : as per project specification SPEC-{abs(hash(tag)) % 900 + 100}")
        lines.append(f"    Vendor        : (withheld — commercial in confidence)")
        lines.append("")
    (out / "DS-CDU3-register.txt").write_text("\n".join(lines), encoding="utf-8")


def board_note(out: Path) -> None:
    """The one document that trips the approval gate."""
    text = _header(
        "Turnaround Capital Note — CDU-3 Reactor Replacement",
        "BRD-2026-04",
        "HIGHLY CONFIDENTIAL",
    ) + """
BOARD CONFIDENTIAL — NOT FOR CIRCULATION

1. PROPOSAL

   Replacement of the hydrotreater reactor R-501 internals during the 2027
   turnaround, together with retubing of E-201.

2. RATIONALE

   R-501 catalyst cycle length has shortened over three consecutive runs.
   Inspection INS-2026-018 records E-201 wall thickness trending toward the
   retirement limit within two cycles.

3. COMMERCIAL

   Estimated cost and contractor selection are withheld from this extract.
   Any workbench task that quotes this document requires management approval
   before an artifact is produced.

4. DEPENDENCIES

   Isolation of R-501 follows SOP-311. C-301 and K-102 remain in service on
   the alternate circuit; TK-401 provides intermediate storage throughout.
"""
    (out / "BRD-2026-04_turnaround_note.txt").write_text(text, encoding="utf-8")


def public_bulletin(out: Path) -> None:
    text = _header(
        "Safety Performance Bulletin — CDU-3",
        "PUB-2026-01",
        "FOR PUBLIC RELEASE",
    ) + """
This bulletin is issued for public release and contains no commercially
sensitive information.

CDU-3 completed the reporting period with no lost-time injuries. Routine
inspection of rotating equipment (P-101, P-102, K-102) and the crude preheat
exchanger E-201 was carried out on schedule. Relief protection across the unit,
including PSV-107, remains within its certification interval.

The unit continues to operate under its standard procedures for isolation
(SOP-204) and relief valve testing (SOP-311).
"""
    (out / "PUB-2026-01_safety_bulletin.txt").write_text(text, encoding="utf-8")


def maintenance_log(out: Path) -> None:
    """Numeric data, so the coding workspace has something real to compute on."""
    random.seed(20260907)
    start = date(2026, 1, 1)
    rows = [
        [
            "date",
            "tag",
            "reading_type",
            "value",
            "unit",
            "shift",
            "operator_note",
        ]
    ]
    readings = {
        "PT-2201": ("discharge_pressure", 12.4, 0.35, "barg"),
        "TT-2202": ("shell_outlet_temp", 178.0, 4.5, "degC"),
        "FIC-305": ("reflux_flow", 92.0, 3.0, "m3/h"),
        "LIC-402": ("tank_level", 61.0, 6.0, "%"),
    }
    for day in range(180):
        stamp = (start + timedelta(days=day)).isoformat()
        for tag, (kind, mean, spread, unit) in readings.items():
            for shift in ("A", "B"):
                value = random.gauss(mean, spread)
                # A slow drift on the pump, so there is something to find.
                if tag == "PT-2201" and day > 120:
                    value -= (day - 120) * 0.012
                note = ""
                if tag == "PT-2201" and value < 11.6:
                    note = "below expected discharge pressure"
                rows.append(
                    [stamp, tag, kind, f"{value:.2f}", unit, shift, note]
                )

    with (out / "MAINT-CDU3-readings.csv").open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out",
        default="../dataset corpus/_generated",
        help="where to write the generated documents",
    )
    args = parser.parse_args()

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    sop_isolation(out)
    sop_relief(out)
    inspection_report(out)
    hazop(out)
    datasheets(out)
    board_note(out)
    public_bulletin(out)
    maintenance_log(out)

    written = sorted(p.name for p in out.iterdir())
    print(f"Wrote {len(written)} files to {out}")
    for name in written:
        print(f"  {name}")
    print(
        "\nEvery document states in its own text that it is generated "
        "demonstration material."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
