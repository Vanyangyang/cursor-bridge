# Cursor Bridge v5.3.5

## Fixed

- A running FIFO task can now be cancelled with the same targeted Stop as a parallel Agent when `cursor_status` has published an Agent ID.
- FIFO tasks that never publish an Agent ID still do not guess-click Stop. Confirm the Cursor chat is stopped, then `abandon`.

## Compatibility

- Live-tested Cursor versions: **3.16.17** and **3.7.42** (workbench and Agents Window). Other versions have not been tested.
