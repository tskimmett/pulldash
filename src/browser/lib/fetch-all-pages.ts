/** Fetch sequential pages in API order until the final, short page. */
export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
  pageSize = 100
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;

  while (true) {
    const data = await fetchPage(page);
    items.push(...data);
    if (data.length < pageSize) return items;
    page++;
  }
}
