# Connector registry and dispatch

`ConnectorRegistryService` loads the generated manifest once at startup from
`resources/connectors/manifest.json`, relative to the API working directory.
A missing file, invalid JSON, or an object without a nonempty connectors
array leaves the registry empty. The loader is not a full schema validator.

- Do not edit the generated manifest by hand. Use `task sync-connectors`;
  set `MANIFEST_PATH` to a local Argus connectors manifest to test it.
- Tools use the manifest slug as their identity. The registry returns config
  schemas and image information; jobs-registry resolves actual inputs and
  configuration at dispatch, and the worker runs the container.
- A connector must have an image and `agentTool: true` to appear as an agent
  connector. Resource defaults are validated per field, with fallbacks of
  `500m` CPU, `512Mi` memory, and 600 seconds.
- Connector logos are stored in the system bucket and served by the logo
  controller. Tool sync writes the files; registry startup does not.
- A tag in the manifest identifies what Core requested. It does not prove
  which cached image content Docker ran. Keep scan evidence separate from
  the manifest reference.

Use the registry consumer specs for manifest, schema, and defaults
changes. Run the worker and local Docker checks when modifying dispatch.
