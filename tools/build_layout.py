#!/usr/bin/env python3
"""Fictional plant generator -> data/layout.json

Ridgeway Cell Works — Plant A (fictional). Every name, number and coordinate
here is invented. Parameters -> coordinates -> checks -> file.

Checks (generation fails with the original message if any check fails):
  C1 CAPA: positions computed from rack rows / floor blocks are within
     +-10% of each storage zone's declared capa.
  C2 Staffing: resources per (group, role, shift) equal the staffing table,
     and the table sums to staffingTotal.
  C3 Geometry: every rack row, floor block, equipment and dock lies inside
     its module; rack/floor/equipment footprints do not overlap; every rack
     row / floor block / equipment lies inside its zone.
  C4 Corridors: no corridor segment passes through a rack or equipment.
  C5 Stand points (pack stations, homes) are inside their zone and not inside
     any footprint.
  C6 Unique ids across every entity list.

Usage:  python3 tools/build_layout.py          # write data/layout.json
        python3 tools/build_layout.py --check  # regenerate, compare bytes
Python standard library only. Output is deterministic (fixed seed, no clock).
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "layout.json")
SEED = 20261023
VERSION = "0.1.0"
F, E, A = "fictional", "estimate", "assumption"   # source tags


def mulberry32(seed):
    """Same generator as src (JS) mulberry32: unsigned 32-bit arithmetic."""
    a = seed & 0xFFFFFFFF

    def rnd():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = t ^ ((t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF)
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return rnd


def r3(v):
    return round(v + 0.0, 3)


def hms(h, m=0):
    return h * 3600 + m * 60


class LayoutError(Exception):
    pass


# --------------------------------------------------------------------------
# Parameters
# --------------------------------------------------------------------------
GLOBAL = {"aisleWidth": 3.5, "pallet": {"w": 1.2, "d": 1.0, "h": 1.2},
          "slotClearance": 0.1, "src": A}

RACK_TYPES = {
    "selective": {"bayWidth": 2.7, "depth": 1.1, "levels": 4, "beamPitch": 1.6,
                  "palletsPerBay": 2, "src": E},
    "highbay": {"bayWidth": 2.8, "depth": 1.2, "levels": 6, "beamPitch": 1.5,
                "palletsPerBay": 2, "src": E},
}

PACKING = {"cellsPerSmall": 300, "smallPerMid": 4, "midPerLarge": 24,
           "smallPerFlatCart": 16, "magazinesPerAmrCart": 8, "emptyMagPerCart": 20,
           "cellsPerMagazine": 300, "src": F}

MODULES = [
    {"id": "OW", "name": "Offsite Warehouse", "rect": [0, 0, 64, 50], "wallH": 9, "color": "#8a94a6", "src": F},
    {"id": "ROAD", "name": "Shuttle Road (shortened)", "rect": [64, 30, 100, 48], "wallH": 0, "color": "#5b6270",
     "note": "Visual distance is shortened; travel time comes from volumes.shuttle.travelMin.", "src": F},
    {"id": "PA", "name": "Plant A", "rect": [100, 0, 220, 90], "wallH": 12, "color": "#9aa3b2", "src": F},
]

ZONES = [
    # id, module, name, cat, rect, capa
    ("OW-RCV", "OW", "Offsite Receiving", "ow", [2, 34, 20, 48], 24),
    ("OW-QI", "OW", "Quality Hold", "ow", [22, 34, 46, 48], 30),
    ("OW-STO", "OW", "Offsite Storage", "ow", [2, 4, 48, 30], 1000),
    ("OW-STG", "OW", "Shuttle Staging", "ow", [53, 4, 63, 28], 32),
    ("PA-DOCK", "PA", "Plant Dock", "rcv", [102, 32, 116, 48], 20),
    ("PA-IQC", "PA", "Label & Incoming Inspection", "rcv", [118, 32, 132, 48], 20),
    ("PA-RM", "PA", "Raw Material Racks", "sto", [102, 4, 132, 27], 560),
    ("PA-HO", "PA", "Line Handover", "cell", [136, 32, 146, 44], 12),
    ("PA-KIT", "PA", "Kitting Area", "cell", [148, 10, 166, 26], None),
    ("PA-CELL", "PA", "Cell Production (context)", "ctx", [148, 32, 218, 58], None),
    ("PA-UNPK", "PA", "Unpack & Re-input", "cell", [136, 46, 146, 58], None),
    ("PA-PACK", "PA", "Packing", "cell", [136, 62, 172, 88], None),
    ("PA-ASRS", "PA", "Magazine AS/RS", "cell", [174, 62, 198, 76], None),
    ("PA-OUT", "PA", "Next Process (context)", "ctx", [200, 64, 218, 88], None),
    ("PA-FG", "PA", "Finished Goods High-bay", "sto", [102, 62, 132, 88], 750),
]


def rows_block(prefix, zone, area, rtype, x0, z_aisle0, pairs, single_last, bays, items_cycle):
    """Back-to-back rack rows along x. Aisle (3.5 m) first, then S/N pair, repeat.
    Returns rack rows and the aisle centre z values (used as corridors)."""
    rt = RACK_TYPES[rtype]
    d, aw = rt["depth"], GLOBAL["aisleWidth"]
    z = z_aisle0
    rows, aisles, n = [], [], 0
    for p in range(pairs + (1 if single_last else 0)):
        aisles.append(r3(z + aw / 2))
        z += aw
        faces = ["S"] if (single_last and p == pairs) else ["S", "N"]
        for face in faces:
            n += 1
            rows.append({"id": f"{prefix}-R{n:02d}", "zone": zone, "type": rtype, "along": "x",
                         "origin": [r3(x0), r3(z)], "bays": bays, "face": face,
                         "area": area, "row": n, "items": items_cycle(n), "override": {}})
            z += d
    if not single_last:
        aisles.append(r3(z + aw / 2))
    return rows, aisles


def rack_rect(row):
    rt = RACK_TYPES[row["type"]]
    bw = row["override"].get("bayWidth", rt["bayWidth"])
    d = row["override"].get("depth", rt["depth"])
    x0, z0 = row["origin"]
    if row["along"] == "x":
        return [x0, z0, r3(x0 + bw * row["bays"]), r3(z0 + d)]
    return [x0, z0, r3(x0 + d), r3(z0 + bw * row["bays"])]


def rack_positions(row):
    rt = RACK_TYPES[row["type"]]
    lv = row["override"].get("levels", rt["levels"])
    pb = row["override"].get("palletsPerBay", rt["palletsPerBay"])
    return row["bays"] * lv * pb


def floor_rect(fb):
    x0, z0 = fb["origin"]
    px, pz = fb["pitch"]
    w, d = fb["slot"]
    return [x0, z0, r3(x0 + px * (fb["cols"] - 1) + w), r3(z0 + pz * (fb["rows"] - 1) + d)]


def inside(r, outer, eps=1e-6):
    return r[0] >= outer[0] - eps and r[1] >= outer[1] - eps and r[2] <= outer[2] + eps and r[3] <= outer[3] + eps


def overlap(a, b, eps=1e-6):
    return a[0] < b[2] - eps and b[0] < a[2] - eps and a[1] < b[3] - eps and b[1] < a[3] - eps


def pt_in(p, r, eps=1e-6):
    return r[0] + eps < p[0] < r[2] - eps and r[1] + eps < p[1] < r[3] - eps


def seg_hits_rect(c, r):
    if c["axis"] == "x":   # line z = at, x from..to
        return r[1] < c["at"] < r[3] and c["from"] < r[2] and r[0] < c["to"]
    return r[0] < c["at"] < r[2] and c["from"] < r[3] and r[1] < c["to"]


def build():
    rnd = mulberry32(SEED)

    rm_items = [
        ("RM-100101", "Electrode Foil Roll A"), ("RM-100102", "Electrode Foil Roll B"),
        ("RM-100215", "Separator Film Roll"), ("RM-100330", "Electrolyte Drum"),
        ("RM-100418", "Can Housing Tray"), ("RM-100422", "Cap Assembly Tray"),
        ("RM-100507", "Tab Lead Reel"), ("RM-100611", "Insulation Tape Reel"),
    ]
    fg_items = [("FG-200101", "Cell Model A1"), ("FG-200102", "Cell Model A2"), ("FG-200201", "Cell Model B1")]
    items = ([{"pn": p, "desc": d, "uom": "PLT", "kind": "RM", "src": F} for p, d in rm_items]
             + [{"pn": p, "desc": d, "uom": "EA", "kind": "FG", "src": F} for p, d in fg_items])

    def rm_cycle(n):
        return [rm_items[(n - 1) % len(rm_items)][0], rm_items[n % len(rm_items)][0]]

    def fg_cycle(n):
        return [fg_items[(n - 1) % len(fg_items)][0]]

    # ---- rack rows (bay 01 = end nearest the main cross corridor, which is east) ----
    ow_rows, ow_aisles = rows_block("OW", "OW-STO", "OW", "selective", 4, 4, 4, False, 16, rm_cycle)
    rm_rows, rm_aisles = rows_block("RM", "PA-RM", "RM", "selective", 104, 4, 3, True, 10, rm_cycle)
    fg_rows, fg_aisles = rows_block("FG", "PA-FG", "FG", "highbay", 104, 62, 3, True, 9, fg_cycle)
    rack_rows = ow_rows + rm_rows + fg_rows
    base_fill = {"OW": 0.75, "RM": 0.60, "FG": 0.55}
    for row in rack_rows:
        row["fill"] = r3(base_fill[row["area"]] + (rnd() - 0.5) * 0.10)
        row["bay01"] = "east"
        row["src"] = F

    # ---- floor slot blocks ----
    floors = [
        {"id": "FL-OW-RCV", "zone": "OW-RCV", "label": "RCV", "origin": [3, 35], "cols": 6, "rows": 4,
         "pitch": [2.6, 2.8], "slot": [1.2, 1.0], "fill": 0.25, "src": F},
        {"id": "FL-OW-QI", "zone": "OW-QI", "label": "QI", "origin": [23, 35], "cols": 8, "rows": 4,
         "pitch": [2.6, 2.8], "slot": [1.2, 1.0], "fill": 0.30, "src": F},
        {"id": "FL-OW-STG", "zone": "OW-STG", "label": "STG", "origin": [53.6, 5], "cols": 4, "rows": 8,
         "pitch": [2.3, 2.8], "slot": [1.2, 1.0], "fill": 0.10, "src": F},
        {"id": "FL-PA-DOCK", "zone": "PA-DOCK", "label": "DCK", "origin": [103, 33], "cols": 4, "rows": 5,
         "pitch": [2.6, 2.8], "slot": [1.2, 1.0], "fill": 0.0, "src": F},
        {"id": "FL-PA-IQC", "zone": "PA-IQC", "label": "IQC", "origin": [119, 33], "cols": 4, "rows": 5,
         "pitch": [2.6, 2.8], "slot": [1.2, 1.0], "fill": 0.20, "src": F},
        {"id": "FL-PA-HO", "zone": "PA-HO", "label": "HO", "origin": [137, 33], "cols": 3, "rows": 4,
         "pitch": [2.6, 2.8], "slot": [1.2, 1.0], "fill": 0.25, "src": F},
    ]

    # ---- equipment ----
    equipment = [
        {"id": "ASRS-1", "zone": "PA-ASRS", "type": "asrs", "name": "Magazine AS/RS", "rect": [176, 64, 196, 74],
         "h": 10, "ports": {"packOut": [175.2, 69], "reinputIn": [186, 63.2], "amrOut": [196.8, 69]}, "src": F},
        {"id": "TBL-ID", "zone": "PA-PACK", "type": "table", "name": "ID & Label Table", "rect": [166.5, 68, 169.5, 71], "h": 0.9, "src": F},
        {"id": "TBL-INS", "zone": "PA-PACK", "type": "table", "name": "Inspection Table", "rect": [161.5, 68, 164.5, 71], "h": 0.9, "src": F},
        {"id": "SHR-1", "zone": "PA-PACK", "type": "shrinkWrapper", "name": "Shrink Wrapper 1", "rect": [155, 67, 159, 72], "h": 2.2, "src": F},
        {"id": "SHR-2", "zone": "PA-PACK", "type": "shrinkWrapper", "name": "Shrink Wrapper 2", "rect": [155, 74, 159, 79], "h": 2.2,
         "note": "Active only with packOption 2", "src": F},
        {"id": "TBL-STF", "zone": "PA-PACK", "type": "table", "name": "Mid-box Stuffing Table", "rect": [144, 78, 148, 81], "h": 0.9, "src": F},
        {"id": "TBL-PLT", "zone": "PA-PACK", "type": "palletStand", "name": "Large-box Pallet Stand", "rect": [139, 78, 142, 81], "h": 0.3, "src": F},
        {"id": "BND-1", "zone": "PA-PACK", "type": "bander", "name": "Banding Machine", "rect": [137, 83, 140, 86], "h": 2.4, "src": F},
        {"id": "TBL-UNPK", "zone": "PA-UNPK", "type": "table", "name": "Unpack Table", "rect": [138, 50, 142, 53], "h": 0.9, "src": F},
        {"id": "TBL-MAG", "zone": "PA-UNPK", "type": "table", "name": "Magazine Load Table", "rect": [143, 50, 145.5, 53], "h": 0.9, "src": F},
        {"id": "KIT-1", "zone": "PA-KIT", "type": "table", "name": "Kitting Table 1", "rect": [150, 14, 156, 18], "h": 0.9, "src": F},
        {"id": "KIT-2", "zone": "PA-KIT", "type": "table", "name": "Kitting Table 2", "rect": [158, 14, 164, 18], "h": 0.9, "src": F},
        {"id": "LINE-1", "zone": "PA-CELL", "type": "cellLine", "name": "Cell Line (context)", "rect": [152, 38, 214, 52], "h": 4, "src": F},
    ]

    docks = [
        {"id": "D-OW-IN", "module": "OW", "at": [0, 41], "dir": "W", "door": 3.5, "use": "supplier inbound", "src": F},
        {"id": "D-OW-1", "module": "OW", "at": [64, 36], "dir": "E", "door": 3.5, "use": "shuttle load", "src": F},
        {"id": "D-OW-2", "module": "OW", "at": [64, 42], "dir": "E", "door": 3.5, "use": "shuttle load", "src": F},
        {"id": "D-PA-1", "module": "PA", "at": [100, 36], "dir": "W", "door": 3.5, "use": "shuttle unload", "src": F},
        {"id": "D-PA-2", "module": "PA", "at": [100, 42], "dir": "W", "door": 3.5, "use": "shuttle unload", "src": F},
    ]

    corridors = [
        {"id": "C-OW-Z", "module": "OW", "axis": "z", "at": 50, "from": 2, "to": 48},
        {"id": "C-OW-X", "module": "OW", "axis": "x", "at": 31.5, "from": 2, "to": 62},
        {"id": "C-RD", "module": "ROAD", "axis": "x", "at": 39, "from": 64, "to": 100},
        {"id": "C-PA-Z", "module": "PA", "axis": "z", "at": 134, "from": 2, "to": 88},
        {"id": "C-PA-X1", "module": "PA", "axis": "x", "at": 30, "from": 101, "to": 218},
        {"id": "C-PA-X2", "module": "PA", "axis": "x", "at": 60, "from": 101, "to": 218},
    ]
    for i, z in enumerate(ow_aisles, 1):
        corridors.append({"id": f"C-OW-A{i}", "module": "OW", "axis": "x", "at": z, "from": 2, "to": 50})
    for i, z in enumerate(rm_aisles, 1):
        corridors.append({"id": f"C-RM-A{i}", "module": "PA", "axis": "x", "at": z, "from": 102, "to": 134})
    for i, z in enumerate(fg_aisles, 1):
        corridors.append({"id": f"C-FG-A{i}", "module": "PA", "axis": "x", "at": z, "from": 102, "to": 134})
    for c in corridors:
        c["src"] = F

    pack_stations = {
        "src": A,
        "points": [
            {"id": "discharge", "zone": "PA-ASRS", "equip": "ASRS-1", "at": [175.2, 69], "sec": 12},
            {"id": "idLabel", "zone": "PA-PACK", "equip": "TBL-ID", "at": [168, 71.8], "sec": 30},
            {"id": "inspect", "zone": "PA-PACK", "equip": "TBL-INS", "at": [163, 71.8], "sec": 35},
            {"id": "shrink", "zone": "PA-PACK", "equip": "SHR-1", "at": [157, 72.8], "sec": 50},
            {"id": "shrink2", "zone": "PA-PACK", "equip": "SHR-2", "at": [157, 79.8], "sec": 50},
            {"id": "stuff", "zone": "PA-PACK", "equip": "TBL-STF", "at": [146, 81.8], "sec": 60},
            {"id": "palletize", "zone": "PA-PACK", "equip": "TBL-PLT", "at": [140.5, 81.8], "sec": 40},
            {"id": "band", "zone": "PA-PACK", "equip": "BND-1", "at": [141, 84.5], "sec": 180},
            {"id": "unpack", "zone": "PA-UNPK", "equip": "TBL-UNPK", "at": [140, 53.8], "sec": 25},
            {"id": "magLoad", "zone": "PA-UNPK", "equip": "TBL-MAG", "at": [144.2, 53.8], "sec": 20},
            {"id": "asrsIn", "zone": "PA-ASRS", "equip": "ASRS-1", "at": [186, 63.2], "sec": 15},
            {"id": "amrOut", "zone": "PA-ASRS", "equip": "ASRS-1", "at": [196.8, 69], "sec": 15},
            {"id": "nextProcess", "zone": "PA-OUT", "equip": None, "at": [209, 76], "sec": 20},
        ],
        "flatCartPath": [[154.2, 69.5], [151, 69.5], [151, 79.5], [148.6, 79.5]],
        "note": "sec = task time per small box (band: per large box, palletize: per mid box, stuff: per mid box).",
    }

    resource_types = [
        {"id": "forklift", "speed": 2.2, "speedLoaded": 1.8, "capacity": 1, "capUnit": "PLT", "turnRadius": 2.1, "color": "#e3a21a", "src": E},
        {"id": "palletJack", "speed": 1.2, "speedLoaded": 1.0, "capacity": 1, "capUnit": "PLT", "turnRadius": 1.2, "color": "#d9822b", "src": E},
        {"id": "amr", "speed": 1.0, "speedLoaded": 0.9, "capacity": 8, "capUnit": "magazine", "turnRadius": 0.8, "color": "#2b8fd9", "src": E},
        {"id": "truck", "speed": 8.0, "speedLoaded": 8.0, "capacity": 28, "capUnit": "PLT", "turnRadius": 9.0, "color": "#c8ccd4", "src": E},
        {"id": "flatCart", "speed": 1.0, "speedLoaded": 0.9, "capacity": 16, "capUnit": "small box", "turnRadius": 0.8, "color": "#6c8ebf", "src": E},
        {"id": "magCart", "speed": 1.0, "speedLoaded": 0.9, "capacity": 20, "capUnit": "empty magazine", "turnRadius": 0.8, "color": "#7a9e7e", "src": E},
        {"id": "worker", "speed": 1.2, "speedLoaded": 1.1, "capacity": 1, "capUnit": "box", "turnRadius": 0.0, "color": "#f2f2f2", "src": E},
    ]

    def res(id_, type_, name, role, group, process, flow, home, shift, zone, **kw):
        d = {"id": id_, "type": type_, "name": name, "role": role, "group": group, "process": process,
             "flow": flow, "home": home, "shift": shift, "zone": zone}
        d.update(kw)
        d["src"] = F
        return d

    resources = [
        res("FL-OW-1", "forklift", "Forklift OW-1", "Forklift Driver", "Offsite Warehouse", "ow-move", "A", [51, 33], "A", "OW-STO"),
        res("FL-OW-2", "forklift", "Forklift OW-2", "Forklift Driver", "Offsite Warehouse", "ow-move", "A", [51, 30], "A", "OW-STO"),
        res("FL-OW-3", "forklift", "Forklift OW-3", "Forklift Driver", "Offsite Warehouse", "ow-move", "A", [51, 33], "B", "OW-STO"),
        res("MH-OW-1", "worker", "Material Handler OW-1", "Material Handler", "Offsite Warehouse", "ow-label", "A", [12, 33], "A", "OW-RCV"),
        res("MH-OW-2", "worker", "Material Handler OW-2", "Material Handler", "Offsite Warehouse", "ow-label", "A", [12, 33], "B", "OW-RCV"),
        res("TRK-1", "truck", "Shuttle 1", "Shuttle Driver", "Transport", "shuttle", "A", [70, 39], "A", "OW-STG"),
        res("TRK-2", "truck", "Shuttle 2", "Shuttle Driver", "Transport", "shuttle", "A", [70, 39], "B", "OW-STG"),
        res("FL-PA-1", "forklift", "Forklift PA-1", "Forklift Driver", "Receiving", "pa-receive", "A", [117, 30], "A", "PA-DOCK"),
        res("FL-PA-2", "forklift", "Forklift PA-2", "Forklift Driver", "Receiving", "pa-receive", "A", [117, 30], "B", "PA-DOCK"),
        res("MH-PA-1", "worker", "Material Handler PA-1", "Material Handler", "Receiving", "pa-iqc", "A", [125, 31], "A", "PA-IQC"),
        res("MH-PA-2", "worker", "Material Handler PA-2", "Material Handler", "Receiving", "pa-iqc", "A", [125, 31], "B", "PA-IQC"),
        res("FL-PA-3", "forklift", "Forklift PA-3", "Forklift Driver", "RM Feeding", "pa-feed", "A", [134, 28], "A", "PA-RM"),
        res("FL-PA-4", "forklift", "Forklift PA-4", "Forklift Driver", "RM Feeding", "pa-feed", "A", [134, 28], "B", "PA-RM"),
        res("PJ-1", "palletJack", "Pallet Jack 1", "Material Handler", "RM Feeding", "pa-handover", "A", [147, 31], "A", "PA-HO"),
        res("PJ-2", "palletJack", "Pallet Jack 2", "Material Handler", "RM Feeding", "pa-handover", "A", [147, 31], "B", "PA-HO"),
        res("PK-1", "worker", "Packer 1", "Packer", "Packing", "idLabel", "B", [168, 71.8], "A", "PA-PACK"),
        res("PK-2", "worker", "Packer 2", "Packer", "Packing", "inspect", "B", [163, 71.8], "A", "PA-PACK"),
        res("PK-3", "worker", "Packer 3", "Packer", "Packing", "shrink", "B", [157, 72.8], "A", "PA-PACK"),
        res("PK-4", "worker", "Packer 4", "Packer", "Packing", "stuff", "B", [146, 81.8], "A", "PA-PACK"),
        res("PK-5", "worker", "Packer 5", "Packer", "Packing", "idLabel", "B", [168, 71.8], "B", "PA-PACK"),
        res("PK-6", "worker", "Packer 6", "Packer", "Packing", "inspect", "B", [163, 71.8], "B", "PA-PACK"),
        res("PK-7", "worker", "Packer 7", "Packer", "Packing", "shrink", "B", [157, 72.8], "B", "PA-PACK"),
        res("PK-8", "worker", "Packer 8", "Packer", "Packing", "stuff", "B", [146, 81.8], "B", "PA-PACK"),
        res("FL-PA-5", "forklift", "Forklift PA-5", "Forklift Driver", "FG & Re-input", "fg-move", "B", [134, 61], "A", "PA-FG"),
        res("FL-PA-6", "forklift", "Forklift PA-6", "Forklift Driver", "FG & Re-input", "fg-move", "B", [134, 61], "B", "PA-FG"),
        res("MH-UP-1", "worker", "Material Handler UP-1", "Material Handler", "FG & Re-input", "unpack", "B", [140, 53.8], "A", "PA-UNPK"),
        res("MH-UP-2", "worker", "Material Handler UP-2", "Material Handler", "FG & Re-input", "unpack", "B", [140, 53.8], "B", "PA-UNPK"),
        res("OPS-1", "worker", "Operations Support", "Operations Support", "Support", "support", "AB", [135.5, 59], "A", "PA-HO"),
        res("FC-1", "flatCart", "Flat Cart 1", "Equipment", "Equipment", "flatCart", "B", [154.2, 69.5], "all", "PA-PACK", person=False),
        res("MC-1", "magCart", "Magazine Cart 1", "Equipment", "Equipment", "magCart", "B", [144.2, 55], "all", "PA-UNPK", person=False),
    ]
    for i in range(1, 4):
        resources.append(res(f"AMR-IN-{i}", "amr", f"AMR In {i}", "AMR", "Equipment", "amrIn", "B",
                             [147 + i * 1.5, 59], "all", "PA-UNPK", person=False, presetGated="equip.amrIn", gateIndex=i))
    for i in range(1, 4):
        resources.append(res(f"AMR-OUT-{i}", "amr", f"AMR Out {i}", "AMR", "Equipment", "amrOut", "B",
                             [198.8, 64.5 + i * 2], "all", "PA-ASRS", person=False, presetGated="equip.amrOut", gateIndex=i))

    staffing = [
        {"group": "Offsite Warehouse", "role": "Forklift Driver", "shift": "A", "n": 2},
        {"group": "Offsite Warehouse", "role": "Forklift Driver", "shift": "B", "n": 1},
        {"group": "Offsite Warehouse", "role": "Material Handler", "shift": "A", "n": 1},
        {"group": "Offsite Warehouse", "role": "Material Handler", "shift": "B", "n": 1},
        {"group": "Transport", "role": "Shuttle Driver", "shift": "A", "n": 1},
        {"group": "Transport", "role": "Shuttle Driver", "shift": "B", "n": 1},
        {"group": "Receiving", "role": "Forklift Driver", "shift": "A", "n": 1},
        {"group": "Receiving", "role": "Forklift Driver", "shift": "B", "n": 1},
        {"group": "Receiving", "role": "Material Handler", "shift": "A", "n": 1},
        {"group": "Receiving", "role": "Material Handler", "shift": "B", "n": 1},
        {"group": "RM Feeding", "role": "Forklift Driver", "shift": "A", "n": 1},
        {"group": "RM Feeding", "role": "Forklift Driver", "shift": "B", "n": 1},
        {"group": "RM Feeding", "role": "Material Handler", "shift": "A", "n": 1},
        {"group": "RM Feeding", "role": "Material Handler", "shift": "B", "n": 1},
        {"group": "Packing", "role": "Packer", "shift": "A", "n": 4},
        {"group": "Packing", "role": "Packer", "shift": "B", "n": 4},
        {"group": "FG & Re-input", "role": "Forklift Driver", "shift": "A", "n": 1},
        {"group": "FG & Re-input", "role": "Forklift Driver", "shift": "B", "n": 1},
        {"group": "FG & Re-input", "role": "Material Handler", "shift": "A", "n": 1},
        {"group": "FG & Re-input", "role": "Material Handler", "shift": "B", "n": 1},
        {"group": "Support", "role": "Operations Support", "shift": "A", "n": 1},
    ]
    for s in staffing:
        s["src"] = F
    staffing_total = {"persons": 28, "src": F}

    volumes = {
        "daily": {"rmPallets": 120, "fgLargeBoxes": 12, "reinputLargeBoxes": 4, "src": F},
        "levels": [{"level": i, "factor": f, "src": A} for i, f in enumerate([1.0, 1.2, 1.4, 1.6, 1.8])],
        "shuttle": {"depart": [hms(h, 30) for h in (0, 3, 6, 9, 12, 15, 18, 21)], "travelMin": 25,
                    "PLT": 28, "loadMinPerPlt": 1.5, "src": F},
        "shifts": {"A": [hms(6), hms(18)], "B": [hms(18), hms(30)], "src": A},
    }

    assumptions = {
        "packOption": 1, "volumeLevel": 0, "equip": {"amrIn": 2, "amrOut": 2},
        "manualKitting": False, "glSplit": False, "moveMetric": "corridor",
        "lot": {"palletsPerBatch": 4, "magazinesPerLot": 48},
        "src": A,
        "doc": {
            "packOption": "1 = one shrink wrapper (SHR-1); 2 = two wrappers (SHR-1 + SHR-2).",
            "volumeLevel": "0-4, index into volumes.levels (daily volume factor).",
            "equip": "Active AMR count per direction (1-3); resources gated by presetGated/gateIndex.",
            "manualKitting": "true = RM is kitted by hand at the line handover (extra Material Handler time).",
            "glSplit": "true = goods-to-line split: kitting moves to the Kitting Area (PA-KIT), handover only hands over kits.",
            "moveMetric": "Travel distance measured along corridors (approach -> corridor axis -> approach).",
            "lot": "Batch and lot granularity for lineage ids.",
        },
    }

    presets = [
        {"id": "asWas", "label": "AS-WAS", "desc": "Manual kitting at the handover, one shrink wrapper, one AMR each way.",
         "set": {"packOption": 1, "equip": {"amrIn": 1, "amrOut": 1}, "manualKitting": True, "glSplit": False}, "src": A},
        {"id": "asIs", "label": "AS-IS", "desc": "Current baseline: no manual kitting, one shrink wrapper, two AMRs each way.",
         "set": {"packOption": 1, "equip": {"amrIn": 2, "amrOut": 2}, "manualKitting": False, "glSplit": False}, "src": A},
        {"id": "toBe", "label": "TO-BE", "desc": "Two shrink wrappers, three AMRs each way, kitting split into its own area.",
         "set": {"packOption": 2, "equip": {"amrIn": 3, "amrOut": 3}, "manualKitting": False, "glSplit": True}, "src": A},
    ]
    compare_metrics = {"core": ["packingUtilization", "dailyThroughput", "stagingDwellAvg"],
                       "labels": {"packingUtilization": "Packing utilization", "dailyThroughput": "Daily throughput (large boxes)",
                                  "stagingDwellAvg": "Avg staging dwell"}}

    id_formats = {
        "po": {"prefix": "45", "digits": 8}, "grDoc": {"prefix": "50", "digits": 8},
        "batch": {"prefix": "B", "date": "YYMMDD", "digits": 3}, "barcode": {"prefix": "SB", "digits": 10},
        "lot": {"prefix": "L", "date": "YYMMDD", "digits": 5}, "transfer": {"prefix": "ST", "digits": 8},
        "magazine": {"prefix": "MZ-", "digits": 5}, "smallBox": {"prefix": "SBX-", "digits": 6},
        "midBox": {"prefix": "MBX-", "digits": 5}, "largeBox": {"prefix": "LBX-", "digits": 4},
        "dateCode": "261023", "note": "Dummy formats for a fictional plant.",
    }

    layout = {
        "meta": {"name": "Ridgeway Cell Works - Plant A", "fictional": True, "units": "m",
                 "coords": {"origin": "bottom-left", "x": "east", "z": "north", "y": "up"},
                 "version": VERSION, "seed": SEED, "generator": "tools/build_layout.py",
                 "srcTags": {F: "invented for this demo", E: "rough industry-typical guess", A: "modeling assumption"},
                 "note": "All names, numbers and layout are fictional.", "src": F},
        "defaults": {"global": GLOBAL, "rackTypes": RACK_TYPES, "packing": PACKING},
        "modules": MODULES,
        "zones": [{"id": z[0], "module": z[1], "name": z[2], "cat": z[3], "rect": z[4], "capa": z[5],
                   "capaUnit": "PLT" if z[5] else None, "src": F} for z in ZONES],
        "rackRows": rack_rows, "floors": floors, "equipment": equipment, "docks": docks, "corridors": corridors,
        "items": items, "volumes": volumes, "resourceTypes": resource_types, "resources": resources,
        "staffing": staffing, "staffingTotal": staffing_total, "packStations": pack_stations,
        "assumptions": assumptions, "presets": presets, "compareMetrics": compare_metrics, "idFormats": id_formats,
    }
    check(layout)
    return layout


def check(L):
    errs = []
    mod = {m["id"]: m["rect"] for m in L["modules"]}
    zones = {z["id"]: z for z in L["zones"]}

    # C6 unique ids
    seen = {}
    for key in ("modules", "zones", "rackRows", "floors", "equipment", "docks", "corridors", "resources", "presets"):
        for o in L[key]:
            if o["id"] in seen:
                errs.append(f"C6 duplicate id {o['id']} in {key} and {seen[o['id']]}")
            seen[o["id"]] = key

    # C3 geometry
    fps = []
    for r in L["rackRows"]:
        fps.append((r["id"], rack_rect(r), r["zone"]))
    for f in L["floors"]:
        fps.append((f["id"], floor_rect(f), f["zone"]))
    for e in L["equipment"]:
        fps.append((e["id"], e["rect"], e["zone"]))
    for fid, rect, zid in fps:
        z = zones[zid]
        if not inside(rect, z["rect"]):
            errs.append(f"C3 {fid} {rect} not inside zone {zid} {z['rect']}")
        if not inside(rect, mod[z["module"]]):
            errs.append(f"C3 {fid} not inside module {z['module']}")
    for z in L["zones"]:
        if not inside(z["rect"], mod[z["module"]]):
            errs.append(f"C3 zone {z['id']} not inside module {z['module']}")
    for i in range(len(fps)):
        for j in range(i + 1, len(fps)):
            if overlap(fps[i][1], fps[j][1]):
                errs.append(f"C3 overlap {fps[i][0]} x {fps[j][0]}")
    for d in L["docks"]:
        r = mod[d["module"]]
        x, z = d["at"]
        on_wall = (abs(x - r[0]) < 1e-6 or abs(x - r[2]) < 1e-6) and r[1] <= z <= r[3]
        if not on_wall:
            errs.append(f"C3 dock {d['id']} not on a {d['module']} wall")

    # C4 corridors
    solid = [(fid, rect) for fid, rect, _ in fps if not fid.startswith("FL-")]
    for c in L["corridors"]:
        for fid, rect in solid:
            if seg_hits_rect(c, rect):
                errs.append(f"C4 corridor {c['id']} passes through {fid}")

    # C5 stand points
    for p in L["packStations"]["points"]:
        z = zones[p["zone"]]["rect"]
        if not (z[0] <= p["at"][0] <= z[2] and z[1] <= p["at"][1] <= z[3]):
            errs.append(f"C5 pack point {p['id']} outside zone {p['zone']}")
        for fid, rect, _ in fps:
            if pt_in(p["at"], rect):
                errs.append(f"C5 pack point {p['id']} inside {fid}")
    for r in L["resources"]:
        for fid, rect, _ in fps:
            if pt_in(r["home"], rect):
                errs.append(f"C5 home of {r['id']} inside {fid}")

    # C1 CAPA
    calc = {}
    for r in L["rackRows"]:
        calc[r["zone"]] = calc.get(r["zone"], 0) + rack_positions(r)
    for f in L["floors"]:
        calc[f["zone"]] = calc.get(f["zone"], 0) + f["cols"] * f["rows"]
    for z in L["zones"]:
        c = calc.get(z["id"], 0)
        if z["capa"] is None:
            if c:
                errs.append(f"C1 zone {z['id']} has slots ({c}) but no capa")
            z["capaCalc"] = None
            continue
        z["capaCalc"] = c
        if not (0.9 * z["capa"] <= c <= 1.1 * z["capa"]):
            errs.append(f"C1 CAPA {z['id']}: computed {c} vs declared {z['capa']} (outside +-10%)")

    # C2 staffing
    persons = [r for r in L["resources"] if r.get("person", True)]
    total = 0
    for s in L["staffing"]:
        n = sum(1 for r in persons if r["group"] == s["group"] and r["role"] == s["role"] and r["shift"] == s["shift"])
        if n != s["n"]:
            errs.append(f"C2 staffing {s['group']}/{s['role']}/{s['shift']}: resources {n} vs table {s['n']}")
        total += s["n"]
    if total != L["staffingTotal"]["persons"] or len(persons) != total:
        errs.append(f"C2 staffingTotal {L['staffingTotal']['persons']} vs table {total} vs person resources {len(persons)}")

    if errs:
        raise LayoutError("layout checks failed:\n  " + "\n  ".join(errs))


def dump(layout):
    return json.dumps(layout, ensure_ascii=False, indent=1) + "\n"


def selftest():
    """Each check must fire on a deliberately broken copy (negative tests)."""
    import copy
    base = build()
    cases = {
        "C1": lambda L: next(z for z in L["zones"] if z["id"] == "PA-RM").__setitem__("capa", 500),  # 560 vs 500
        "C2": lambda L: L["resources"].pop(0),                                                 # one driver missing
        "C3": lambda L: L["equipment"][1].__setitem__("rect", [160, 68, 163, 71]),           # TBL-ID onto TBL-INS
        "C4": lambda L: L["corridors"].append({"id": "C-BAD", "module": "PA", "axis": "x", "at": 69, "from": 150, "to": 170}),
        "C5": lambda L: L["packStations"]["points"][1].__setitem__("at", [168, 69.5]),       # inside TBL-ID
        "C6": lambda L: L["docks"].append(dict(L["docks"][0])),
    }
    bad = []
    for tag, mutate in cases.items():
        L = copy.deepcopy(base)
        mutate(L)
        try:
            check(L)
            bad.append(f"{tag} did not fire")
        except LayoutError as e:
            if f"{tag} " not in str(e):
                bad.append(f"{tag} fired other checks only: {e}")
    if bad:
        print("selftest FAILED:\n  " + "\n  ".join(bad))
        sys.exit(1)
    print(f"selftest ok - {len(cases)} negative cases each caught")


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    try:
        text = dump(build())
    except LayoutError as e:
        print(str(e))
        sys.exit(1)
    if "--check" in sys.argv:
        with open(OUT, encoding="utf-8") as f:
            if f.read() != text:
                print("data/layout.json is out of date - run: npm run layout")
                sys.exit(1)
        print("layout ok - data/layout.json matches the generator")
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    L = json.loads(text)
    caps = ", ".join(f"{z['id']} {z['capaCalc']}/{z['capa']}" for z in L["zones"] if z["capa"])
    print(f"wrote data/layout.json ({len(text.encode())} bytes) - CAPA {caps}; persons {L['staffingTotal']['persons']}")


if __name__ == "__main__":
    main()
