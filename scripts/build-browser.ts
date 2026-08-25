import tailwind from "bun-plugin-tailwind";
import { watch } from "fs";
import { cp, rm } from "fs/promises";
import { resolve } from "path";

const isWatch = process.argv.includes("--watch");

async function build() {
  // With code splitting, chunk hash assignments reshuffle between builds;
  // stale chunks from a previous build can shadow current ones. Always
  // start from a clean output directory.
  await rm("./dist/browser", { recursive: true, force: true });

  // Build main app
  const mainResult = await Bun.build({
    entrypoints: ["./src/browser/index.html"],
    outdir: "./dist/browser",
    plugins: [tailwind],
    target: "browser",
    format: "esm",
    // Keep dynamic imports (e.g. mermaid for semantic review diagrams) out
    // of the main bundle.
    splitting: true,
  });

  if (!mainResult.success) {
    console.error("Main build failed:");
    for (const log of mainResult.logs) {
      console.error(log);
    }
    return false;
  }

  // Make paths absolute to root in index.html
  const indexPath = "./dist/browser/index.html";
  let indexHtml = (await Bun.file(indexPath).text()).replaceAll("./", "/");

  // Bun bug: with splitting enabled, the generated index.html can point its
  // <script> at an arbitrary chunk instead of the entry point. Rewrite the
  // src from the build manifest, which reports the entry point correctly.
  const entryJs = mainResult.outputs.find(
    (o) => o.kind === "entry-point" && o.path.endsWith(".js")
  );
  if (entryJs) {
    const entryName = entryJs.path.split("/").pop()!;
    indexHtml = indexHtml.replace(/src="\/[^"]+\.js"/, `src="/${entryName}"`);
  }
  await Bun.write(indexPath, indexHtml);

  await cp(
    resolve(process.cwd(), "src", "browser", "logo.svg"),
    resolve(process.cwd(), "dist", "browser", "logo.svg")
  );

  // Build worker separately with document shim for Prism/refractor
  const workerResult = await Bun.build({
    entrypoints: ["./src/browser/lib/diff-worker.ts"],
    outdir: "./dist/browser/lib",
    target: "browser",
    format: "esm",
    banner: `// Worker shim for libraries that check for document (Prism/refractor)
if (typeof document === 'undefined') {
  globalThis.document = {
    currentScript: null,
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    createElement: () => ({
      setAttribute: () => {},
      getAttribute: () => null,
      appendChild: () => {},
      removeChild: () => {},
      classList: { add: () => {}, remove: () => {}, contains: () => false },
      style: {},
      innerHTML: '',
      textContent: '',
    }),
    createTextNode: () => ({ textContent: '' }),
    createDocumentFragment: () => ({ appendChild: () => {}, childNodes: [] }),
    head: { appendChild: () => {}, removeChild: () => {} },
    body: { appendChild: () => {}, removeChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
`,
  });

  if (!workerResult.success) {
    console.error("Worker build failed:");
    for (const log of workerResult.logs) {
      console.error(log);
    }
    return false;
  }

  const allOutputs = [...mainResult.outputs, ...workerResult.outputs];

  console.log(`Bundled ${allOutputs.length} files`);
  for (const output of allOutputs) {
    console.log(`  ${output.path}`);
  }
  return true;
}

await build();

if (isWatch) {
  console.log("\nWatching for changes...");
  const srcDir = resolve(import.meta.dir, "..", "src", "browser");

  let debounce: Timer | null = null;
  watch(srcDir, { recursive: true }, (_event, filename) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      console.log(`\nFile changed: ${filename}`);
      await build();
    }, 100);
  });
}
