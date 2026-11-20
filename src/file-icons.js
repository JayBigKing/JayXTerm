const drawings = {
  folder: ["M2 6V4.5A1.5 1.5 0 0 1 3.5 3H8l2 2h6.5A1.5 1.5 0 0 1 18 6.5V8", "M2 6h6l2 2h8l-1.5 8H3Z"],
  text: ["M5 2h7l4 4v12H5Z", "M12 2v5h4M8 10h5M8 13h5M8 16h3"],
  code: ["M6 5 2 10l4 5M14 5l4 5-4 5M12 3 8 17"],
  shell: ["M2 4h16v12H2Z", "m5 7 3 3-3 3M10 13h4"],
  config: ["M3 5h14M3 10h14M3 15h14", "M7 3v4M13 8v4M8 13v4"],
  image: ["M3 3h14v14H3Z", "m3 14 4-5 4 4 2-2 4 4", "M12 6h1v1h-1Z"],
  archive: ["M4 2h8l4 4v12H4Z", "M9 2v2h2v2H9v2h2v2H9v2h2v3H8v-3h1"],
  pdf: ["M5 2h7l4 4v12H5Z", "M12 2v5h4M7 13c4-2 5-6 3-5s-1 6 3 6-1-4-6-1Z"],
  database: ["M3 5c0-4 14-4 14 0s-14 4-14 0V15c0 4 14 4 14 0V5", "M3 10c0 4 14 4 14 0"],
  media: ["M3 3h14v14H3Z", "m8 6 6 4-6 4Z"],
  link: ["m8 12 4-4M7 14l-1 1a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M11 6l1-1a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0"],
  file: ["M5 2h7l4 4v12H5Z", "M12 2v5h4"],
};
const extensions = {
  text: "txt md markdown rst log csv tsv nfo",
  code: "c h cc cpp cxx hpp hxx cs java class py pyw js jsx mjs cjs ts tsx go rs rb php phtml lua pl swift kt kts vue svelte html htm css scss less r ex exs scala asm s",
  shell: "sh bash zsh fish ksh bat cmd ps1 psm1 exe com appimage",
  config: "json jsonc yaml yml toml ini conf cfg config env xml properties service socket target desktop lock",
  image: "png jpg jpeg gif svg webp ico bmp tiff tif avif heic",
  archive: "zip tar gz tgz bz2 tbz2 xz txz zst zstd 7z rar deb rpm jar war",
  pdf: "pdf",
  database: "sql db sqlite sqlite3 db3",
  media: "mp3 wav flac ogg aac m4a mp4 mkv mov avi webm",
};
const byExtension = new Map(Object.entries(extensions).flatMap(([kind, names]) => names.split(" ").map(name => [name, kind])));
const labels = { folder: "文件夹", text: "文本文件", code: "代码文件", shell: "脚本或程序", config: "配置文件", image: "图片", archive: "压缩包", pdf: "PDF 文档", database: "数据库或 SQL", media: "音视频", link: "符号链接", file: "文件" };

export function trashIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", "M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12M8 8v6M12 8v6");
  svg.append(path);
  return svg;
}

export function fileIcon(file) {
  const name = file.name.toLowerCase();
  let kind = file.symlink ? "link" : file.directory ? "folder" : byExtension.get(name.split(".").at(-1)) || "file";
  if (kind === "file") {
    if (/^(readme|license|licence|changelog|notice|authors|copying)(\.|$)/.test(name)) kind = "text";
    else if (/^(dockerfile|makefile|cmakelists\.txt|\.bashrc|\.zshrc|\.profile)$/.test(name)) kind = "shell";
    else if (/^(\.gitignore|\.gitattributes|\.dockerignore|\.editorconfig|\.env)(\.|$)/.test(name)) kind = "config";
  }
  const wrapper = document.createElement("span");
  wrapper.className = "file-icon";
  wrapper.dataset.fileKind = kind;
  wrapper.title = labels[kind];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  for (const drawing of drawings[kind]) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", drawing);
    svg.append(path);
  }
  wrapper.append(svg);
  return wrapper;
}
