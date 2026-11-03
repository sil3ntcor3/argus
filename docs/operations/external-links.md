# External link confirmation

This first port of upstream #807 covers Markdown links, asset HTTP URLs and vulnerability source-code locations. Other outbound console links retain their existing behavior until a later batch.

Ordinary clicks on absolute HTTP(S) or protocol-relative URLs show the full destination. Cancel and Escape dismiss the dialog; Open opens the destination in a new tab. Keyboard focus returns to the activating link if it still exists. Long destinations scroll inside the dialog.

Relative paths, non-HTTP schemes, modifier clicks and middle clicks retain native anchor behavior. This confirmation is not a URL sanitizer or a navigation security boundary.

Use `OpenLink` for covered links and mount `OpenLinkDialog` once in the root route. The shared state keeps the dialog alive when a link's owner unmounts. The existing root workspace bootstrap remains in place.

Validate with `task lint`, `task test`, `task console:test:run` and `task console:build`. Browser checks should exercise all three entry points, cancel/confirm, keyboard focus, native modifier clicks and a long URL on a narrow screen. No API regeneration, dependency update or database migration is required.
