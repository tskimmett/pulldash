import { expect, test } from "bun:test";
import { fetchAllPages } from "./fetch-all-pages";

test("fetchAllPages returns every item in order across full and partial pages", async () => {
  const source = Array.from({ length: 182 }, (_, index) => index);
  const requestedPages: number[] = [];

  const items = await fetchAllPages(async (page) => {
    requestedPages.push(page);
    return source.slice((page - 1) * 100, page * 100);
  });

  expect(items).toEqual(source);
  expect(requestedPages).toEqual([1, 2]);

  const exactPageRequests: number[] = [];
  const exactPageSource = source.slice(0, 100);
  const exactPageItems = await fetchAllPages(async (page) => {
    exactPageRequests.push(page);
    return exactPageSource.slice((page - 1) * 100, page * 100);
  });
  expect(exactPageItems).toEqual(exactPageSource);
  expect(exactPageRequests).toEqual([1, 2]);
});
