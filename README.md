# Reco Suite

Reconciliation workbench (Reco), Accounting Entry Generator and Special JVs, run from a shared folder inside the **Automation Hub** pywebview launcher.

| Path | What it is |
|---|---|
| `main.py` | Launcher: sign-in, app tiles, filesystem bridge, **base-folder set / switch / migrate** |
| `folder_manager.py` | Folder inspection, migration engine (copy → verify → switch → optional move) |
| `apps/Reco.html` | The Reco app |
| `apps/lib/` | Vendored PapaParse 5.4.1 and SheetJS 0.18.5 (add your existing jspreadsheet/jsuites files here) |
| `special_jv_templates/TCH.html`, `special_jv_mapping/TCH.json` | The TCH Special JV and its mapping (account codes live in the JSON) |
| `docs/RECO_ARCHITECTURE_HANDOVER.md` | Architecture, bridge contract, every fix in this build |
| `tests/` | `pytest` for the launcher/migration, Playwright end-to-end tests for Reco, TCH and the hub |

## Deploy

1. Copy `apps/Reco.html`, `apps/lib/papaparse.min.js`, `apps/lib/xlsx.full.min.js`, `special_jv_templates/` and `special_jv_mapping/` into the shared base folder (keep your existing `master/`, `reco/`, `reco_data/`, `apps/lib/jspreadsheet*`/`jsuites*`).
2. Put `main.py` and `folder_manager.py` together on each PC (or package them with PyInstaller).
3. `pip install -r requirements.txt`, then `python main.py` (`--debug` opens the dev tools).

The first start asks for the base folder. Later changes go through **📁 Base folder…** in the hub (admin password: `pwd.txt` in the base folder, default `admin123`):

- **Switch to an existing folder** — repoint the hub (no copying).
- **Migrate all files to a new folder** — copies everything, verifies it, switches, and leaves `MIGRATED_TO.txt` so colleagues' launchers offer to follow. Optionally removes the originals after a SHA-256-verified copy.

> `main.py` was rebuilt from the bridge contract in the handover doc because the original launcher was not available. If you keep your own launcher, Reco still works with it (every new bridge method is optional); to add the folder migration to it, copy `folder_manager.py` and the base-folder methods of `LauncherAPI` (`get_folder_info`, `inspect_path`, `browse_folder`, `set_base_folder`, `initialize_folder`, `preflight_migration`, `start_migration`, `migration_status`, `cancel_migration`, `follow_pointer`) plus the settings modal in `HUB_HTML`.

## Tests

```bash
python -m pytest tests/                 # launcher bridge + migration engine
node tests/e2e/run_e2e.mjs              # Reco, TCH and the hub in Chromium against the real bridge
```
