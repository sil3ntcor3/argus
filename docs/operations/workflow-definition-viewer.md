# Viewing workflow definitions

Use **View workflow** on a run or group to open its YAML definition. Run pages
fetch the authorized definition only while the sheet is open. Group pages use
the workflow already returned with the group, including read-only pipelines
that use one tool in several jobs.

The file view places `name`, `on`, and `jobs` first, and lists dependencies before
their consumers. It preserves input preference order, configuration/profile
references, failure policy, unknown fields, and legacy job arrays. Viewing a
definition does not edit it. Loading and missing definitions retain their
existing states; invalid old dependency references do not prevent display.
