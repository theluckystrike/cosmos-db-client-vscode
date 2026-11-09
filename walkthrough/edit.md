# Edit, export and import

- Open an item. double-click a row, or select it and click Open. The item opens as JSON. Ctrl+S (Cmd+S) saves it back.
- Safe saves. the save uses the item's id and partition key as they were when you opened it, with an ETag check. If someone changed the item in the meantime, nothing is overwritten: you can compare with the server version first.
- Exact numbers. A number with more digits than JavaScript holds (for example `9007199254740993`) shows a warning badge and is kept exactly as stored, also when you edit another field.
- New item. right-click a container, New Item. You are asked for the partition key value first.
- Delete. select a row and click Delete. You are always asked first.
- Export. from the results toolbar, every item of the query streams to JSON, JSONL or CSV.
- Import. right-click a container, Import Items, pick a JSON or JSONL file. Items are written in batches with a progress bar and a running RU total.
- Read-only. right-click a connection, Toggle Read-Only, to block every change on it.
