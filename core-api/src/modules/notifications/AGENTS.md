# Argus notifications module

This module serves the authenticated user's notification list, unread count, read state, and removal. It also supports direct delivery to selected recipients. Keep recipient ownership checks on every mutation.

- Workspace event notifications are materialized by the Event Bridge notifications sink. The browser receives live pointers through the separate Events module. Keep the recipient identity and channel format compatible.
- Bulk operations must stay scoped to the calling recipient, including deletion by reference. Use the notifications controller and service specs for query and mutation behavior.
