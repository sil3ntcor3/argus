# Group workflow ownership

Deleting an Argus group removes its bindings and scheduled runs. Shared workspace
workflows and their run histories remain available to other groups.

Only deletable workflows with a filename generated for that group are candidates
for deletion: `group-<group-id>.yaml`, the legacy console name
`group-workflow---<group-id>.yaml`, or `project-<group-id>-...`. Unknown filenames,
missing workflow metadata, and workflows marked `isCanDelete: false` are preserved.

Generated workflows can also be shared. Cleanup locks candidate workflow rows,
rechecks ownership in the same workspace, and preserves any workflow referenced
by another group. PostgreSQL foreign-key locks serialize concurrent attachment
with this decision. A later attachment can fail if deletion wins the race; an
already committed reference is preserved. Failed group creation uses the same
cleanup policy. Removing a group does not grant permission to delete shared data.

No migration or API change is required. Existing workflow deletion permissions
and direct workflow deletion behavior remain unchanged.
