import type { ActionResult, QueryActionData } from 'deepspace/worker'

type Page<T> = QueryActionData<T> & { nextOffset?: number }

/** Follow the SDK continuation, including pages shortened by its response limit. */
export async function* recordPages<T>(
  load: (offset: number) => Promise<ActionResult<QueryActionData<T>>>,
) {
  let offset = 0
  for (;;) {
    const result = await load(offset)
    if (!result.success) throw new Error('Records could not be loaded.')
    const page: Page<T> = result.data
    yield page.records
    if (page.nextOffset === undefined) return
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) {
      throw new Error('Invalid record continuation.')
    }
    offset = page.nextOffset
  }
}
