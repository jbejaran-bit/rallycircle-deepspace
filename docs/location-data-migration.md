# Rally place persistence and migration review

Reviewed against the project's installed `deepspace@0.44.2` schema types and the official [data storage guide](https://docs.deep.space/guides/data-storage.md), [schema reference](https://docs.deep.space/sdk-reference/worker/schemas.md), and [additive-field migration guidance](https://docs.deep.space/agents/add-field-existing-app-without-losing-data.md). No deployment, migration command, backfill, production write or external paid API call was run.

## Persisted shape

`sessions.courtPlace` is one new optional `text` column, `default: ''`, bounded to 1,200 UTF-16 code units. It stores application-validated JSON with only `lat`, `lng`, `id`, `name`, `address`, and `source` (`osm`, `nominatim`, or `featured`). Latitude and longitude must be finite numbers within −90…90 and −180…180; strings are bounded and control characters/unknown keys are rejected. The JSON is canonicalized before writing, so retry/deduplication does not depend on property order.

The existing `court` and `location` text columns are retained with their existing types and limits. Missing, null or empty `courtPlace` reads as a legacy text-only location, without guessed coordinates or a directions link. Malformed pre-existing JSON also renders without a map; editing it through the new form replaces it with a valid selected place or an empty value. There is no geocoding backfill and no inference that similarly named courts are the same physical place.

The SDK supports additive columns when an authorized future deployment registers the schema. No column, collection, field identity or Durable Object class is renamed or removed here. Existing rows may read null/absent until explicitly edited; the default applies to new records and is not used as a claim that old rows were backfilled. The new build must be deployed together with its schema before live use. Rolling back the code should leave the extra stored column intact while the older UI ignores it; this has not been exercised on a live app.

## Writes and concurrency

Creation validates at the action boundary and again inside the per-host serialized creation room. Selected-place metadata participates in exact-draft deduplication. Identical location JSON with a different key order reuses the same rally, while a different meeting point creates a distinct rally. A selected place whose name no longer matches the court text is rejected, preventing a stale pin after a name change.

The new `editDetails` command checks the verified caller is the host, rejects cancelled sessions or sessions with match scoring, validates the whole location tuple, and writes title, notes, court, area and selected-place JSON in one record update. It compares the starting details snapshot to the stored details before writing. Concurrent edits through this command serialize; stale drafts are rejected with recovery guidance, and an exact retry after a lost acknowledgement is a harmless success.

The `court`, `location` and new `courtPlace` fields are excluded from ordinary member/admin direct `writableFields`. This is an intentional permission tightening: external clients that directly patched court/area must use the command. The previously shipped edit form wrote only title/notes; those remain direct-writable for compatibility. Their older direct-write clients do not participate in command-room serialization, so snapshot checking is not a full transactional compare-and-swap guarantee against such a client writing between the command's read and write. New UI edits use the serialized command. Existing attendance, scheduling, scoring and chat commands are unchanged.

No metadata is treated as proof of provider verification or a reservation. The schema validates coordinate shape/range; it cannot prove a public map tag identifies an accessible tennis court. Players still need to check access and booking arrangements. Google Maps directions use only the validated stored `lat,lng` destination and no text-search query or API key.

## Local evidence and limits

Targeted helper/action/command suites passed **64 tests in 4 files**. Coverage includes coordinate bounds and zero, canonical JSON, malformed/oversized metadata, legacy missing/null values, coordinate-based directions, permission boundaries, create forwarding/deduplication, changed meeting points, host authorization, stale concurrent edits, lost acknowledgements, rejected storage writes, and adding/clearing a map on a legacy rally. Existing Node suites passed **35 tests** after introducing the shared validator. Full project checks and browser results are recorded in the follow-up handoff.

Recurring-series templates retain their existing free-text shape; a generated rally can be assigned a precise place through its own edit form. Live additive migration, real RecordRoom enforcement/acknowledgements, eviction behavior and multi-account synchronization remain unverified. Review the schema diff and exercise these in an approved disposable environment before any future production rollout.
