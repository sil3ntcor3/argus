# Argus users module

`UsersService` exposes the user repository and seeds the internal bot identity on startup. The entity and account flows live in `auth`. Platform user reads live in `admin/users`.

- The module exposes no HTTP routes. The root module uses the repository for initialization state.
- The bot is a system identity for unattended agent work. It has no login account and is excluded from the platform user list. Preserve its stable identifier when changing seed behavior.
