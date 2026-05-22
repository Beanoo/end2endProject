const path = require("path");
const { listSourceFiles, readFilePreview } = require("./repoIndex");

const sourceExtensions = [".js", ".jsx", ".mjs", ".cjs", ".json", ".css"];

function stripExtension(file) {
  return file.slice(0, -path.extname(file).length);
}

function parseImports(content) {
  const imports = [];
  const patterns = [
    /import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /export\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /require\(["']([^"']+)["']\)/g,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(content);
    while (match) {
      imports.push(match[1]);
      match = pattern.exec(content);
    }
  }

  return [...new Set(imports)];
}

function resolveImport(fromFile, specifier, allFiles) {
  if (!specifier.startsWith(".")) return null;
  const fromDir = path.posix.dirname(fromFile);
  const base = path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates = [
    ...sourceExtensions.map((ext) => `${base}${ext}`),
    ...sourceExtensions.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((candidate) => allFiles.has(candidate)) || null;
}

function buildImportGraph(repo) {
  const files = listSourceFiles(repo);
  const allFiles = new Set(files);
  const importsByFile = new Map();
  const importersByFile = new Map(files.map((file) => [file, []]));

  for (const file of files) {
    const content = readFilePreview(repo, file, 30000);
    const resolved = parseImports(content)
      .map((specifier) => resolveImport(file, specifier, allFiles))
      .filter(Boolean);
    importsByFile.set(file, [...new Set(resolved)]);
    for (const imported of resolved) {
      importersByFile.get(imported)?.push(file);
    }
  }

  return { files, importsByFile, importersByFile };
}

function basenameToken(file) {
  return path.posix.basename(stripExtension(file)).toLowerCase();
}

function expandFromSeeds(repo, seedFiles, { maxDepth = 1, maxFiles = 24 } = {}) {
  const graph = buildImportGraph(repo);
  const allFiles = new Set(graph.files);
  const queue = [...new Set(seedFiles.filter((file) => allFiles.has(file)))].map((file) => ({
    file,
    depth: 0,
    reason: "seed",
  }));
  const seen = new Map();

  while (queue.length > 0 && seen.size < maxFiles) {
    const current = queue.shift();
    if (seen.has(current.file)) continue;
    seen.set(current.file, current.reason);
    if (current.depth >= maxDepth) continue;

    const related = [
      ...(graph.importsByFile.get(current.file) || []).map((file) => ({
        file,
        reason: `imported by ${current.file}`,
      })),
      ...(graph.importersByFile.get(current.file) || []).map((file) => ({
        file,
        reason: `imports ${current.file}`,
      })),
    ];

    for (const item of related) {
      if (!seen.has(item.file)) {
        queue.push({ ...item, depth: current.depth + 1 });
      }
    }
  }

  return [...seen.entries()].map(([file, reason]) => ({ file, reason }));
}

function findStructuralFiles(repo, seedFiles, terms, { maxFiles = 8 } = {}) {
  const files = listSourceFiles(repo);
  const seedTokens = new Set(seedFiles.map(basenameToken));
  const structuralNames = ["main", "app", "routes", "router", "index"];
  const results = [];

  for (const file of files) {
    const lower = file.toLowerCase();
    const isStructural = structuralNames.some((name) => lower.endsWith(`/${name}.jsx`) || lower.endsWith(`/${name}.js`));
    if (!isStructural) continue;

    const content = readFilePreview(repo, file, 12000).toLowerCase();
    const referencesSeed = [...seedTokens].some((token) => token && content.includes(token));
    if (referencesSeed) {
      results.push({ file, reason: "structural file references seed module" });
    }

    if (results.length >= maxFiles) break;
  }

  return results;
}

function buildExploration(repo, seedFiles, terms) {
  const dependencyFiles = expandFromSeeds(repo, seedFiles, { maxDepth: 2, maxFiles: 40 });
  const structuralFiles = findStructuralFiles(repo, seedFiles, terms);
  const merged = new Map();

  for (const item of [...dependencyFiles, ...structuralFiles]) {
    if (!merged.has(item.file)) merged.set(item.file, item.reason);
  }

  return [...merged.entries()].map(([file, reason]) => ({ file, reason }));
}

module.exports = {
  buildExploration,
};
