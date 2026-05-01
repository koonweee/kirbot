# Dispatcharr IPTV API Notes

Base URL: `https://iptv.sf.kw0.dev`

Authentication: set `X-API-Key: <IPTV_API_KEY>`. The key is stored outside the skill in `/home/kirbot/coding/.env`.

Useful endpoints from `/api/schema/`:

- `GET /api/channels/groups/`: list channel groups.
- `POST /api/channels/groups/`: create a channel group with `{"name": "..."}`.
- `PATCH /api/channels/groups/{id}/`: rename a channel group with `{"name": "..."}`.
- `DELETE /api/channels/groups/{id}/`: delete a group; the server refuses associated groups.
- `POST /api/channels/groups/cleanup/`: delete groups with no channel or M3U associations.
- `GET /api/channels/channels/`: list channels. Query parameters include `channel_group`, `name`, `search`, `ordering`, `page`, and `page_size`.
- `GET /api/channels/channels/{id}/`: retrieve one channel.
- `PATCH /api/channels/channels/{id}/`: partial channel update.
- `POST /api/channels/channels/{id}/reorder/`: move one channel after another. Body: `{"insert_after_id": 456}` or `{"insert_after_id": null}` to move to the beginning.
- `POST /api/channels/channels/assign/`: bulk assign channel numbers. Body: `{"starting_number": 1, "channel_ids": [101, 102, 103]}`.
- `GET /api/channels/channels/summary/`: lightweight list for guide/order work.
- `GET /api/channels/streams/groups/`: stream group data when reconciling source groups.
- `GET /api/m3u/server-groups/`: M3U server groups when comparing provider grouping.

Channel fields commonly needed for rearranging:

- `id`: integer channel ID.
- `channel_number`: numeric guide order.
- `name`: display name.
- `channel_group_id`: destination channel group ID.
- `tvg_id`, `epg_data_id`, `logo_id`: guide/metadata links. Avoid changing these during basic rearranging unless explicitly requested.
- `streams`: stream IDs associated with the channel. Preserve unless intentionally rebuilding the channel.

Channel group fields commonly needed:

- `id`: integer group ID.
- `name`: display name.
- `channel_count`: read-only count.
- `m3u_account_count` and `m3u_accounts`: source-account associations. A group with associations may not be deletable or may be controlled by M3U sync.

Rearranging workflow:

1. List groups and channels in the target area.
2. Build a proposed mapping of channel IDs to destination group IDs and order.
3. Use `patch-channel --dry-run` for group moves and `reorder-channel --dry-run` or `assign-channels --dry-run` for ordering.
4. Apply changes in small batches.
5. Re-list the affected channels with `--ordering channel_number` and verify.
