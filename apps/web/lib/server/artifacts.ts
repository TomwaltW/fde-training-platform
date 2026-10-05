// 资料鉴权下发:只能看本局已经拿到的资料;文件名必须在 artifactFiles() 列表里(防路径穿越)。
import type { StoredSession } from "@fde/contracts";
import { artifactFiles, publicArtifact, type ArtifactFile, type PublicArtifact } from "@fde/engine";
import { HttpError } from "./http.ts";
import { scenarioOf } from "./sessions.ts";

/** 资料不存在 404;本局还没拿到 403。 */
export function obtainedArtifact(s: StoredSession, artifactId: string): PublicArtifact {
  const { scn } = scenarioOf(s);
  if (!scn.artifacts.has(artifactId)) throw new HttpError("not_found", "没有这份资料");
  const art = publicArtifact(scn, s.state, artifactId);
  if (!art) throw new HttpError("forbidden", "你还没有拿到这份资料");
  return art;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 按白名单精确匹配文件名;不在列表里一律 404(包括 ../ 之类的穿越尝试)。 */
export function artifactFile(s: StoredSession, artifactId: string, name: string): ArtifactFile {
  obtainedArtifact(s, artifactId);
  const candidates = new Set([name, safeDecode(name)]);
  const file = artifactFiles(scenarioOf(s).scn, artifactId).find((f) => candidates.has(f.name));
  if (!file) throw new HttpError("not_found", "没有这个文件");
  return file;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function contentType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** 图片和 pdf 在浏览器里直接显示;其他(xlsx 等)作为附件下载。 */
export function contentDisposition(file: ArtifactFile): string {
  const mode = file.kind === "image" || file.kind === "pdf" ? "inline" : "attachment";
  const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`;
}
