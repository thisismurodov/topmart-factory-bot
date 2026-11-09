"""Refresh available goods without repricing or discarding an open cart."""


def refreshed_catalog(previous, available, selected):
    # Keep existing positions: a late Telegram keyboard tap must not select
    # another product after a refresh. Selected rows retain their quoted price.
    live = {row[0]: row for row in available}
    rows = [
        row if selected.get(row[0], 0) > 0 else live.get(row[0], row)
        for row in previous
    ]
    known = {row[0] for row in rows}
    rows.extend(row for row in available if row[0] not in known)
    return rows, set(live)
