# External link confirmation

Upstream #807 now covers its console call sites: Markdown and source citations, chat-provider menus, asset and technology URLs, provider and tool documentation, report downloads, finding references, repository links, integration verification links, and project/help links. Argus repository and help destinations are retained.

Ordinary clicks on absolute HTTP(S) or protocol-relative URLs show the full destination. Cancel and Escape dismiss the dialog; Open opens the destination in a new tab. Keyboard focus returns to the activating link, or its menu trigger when a dropdown item has unmounted. Long destinations scroll inside the dialog.

Relative paths, non-HTTP schemes, modifier clicks and middle clicks retain native anchor behavior. This confirmation is not a URL sanitizer or a navigation security boundary.

Use `OpenLink` for covered links and mount `OpenLinkDialog` once in the root route. The shared state keeps the dialog alive when a link's owner unmounts. Dropdown links open confirmation after the menu finishes restoring focus, so modal focus and Escape remain active. The existing root workspace bootstrap remains in place.

Validate with `task lint`, `task test`, `task console:test:run` and `task console:build`. Browser checks should exercise dropdown links, report downloads, provider/technology links, cancel/confirm, keyboard focus, native modifier clicks and narrow screens. No API regeneration, dependency update or database migration is required.
