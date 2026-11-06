# Pipeline tool inputs and outputs

The tool panel shows **Takes**, in first-available preference order, and **Finds**,
the inventory kinds its results add. Missing legacy metadata is shown as not
declared; an explicit empty output list means the tool adds no inventory kind.

For tools accepting multiple kinds, **Input preference** offers the catalog
default or one accepted kind. Saved multi-kind overrides display their complete
ordered preference as **Custom** and survive unrelated edits. Changing category
clears an incompatible override and retains a compatible preference.

Hints consider outputs declared by tools in strictly earlier stages. Tools in
the same stage run in parallel and cannot supply each other's inputs. Existing
inventory may still satisfy a preferred kind; the backend selects inputs per
asset and enforces workspace, target and service scope. These hints do not run
scans or change that scope.
