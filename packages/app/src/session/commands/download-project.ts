/**
 * The project download (publish step 1): the whole project as one ZIP file,
 * saved through the browser download so it works on web and desktop alike.
 */
export function projectDownloadFilename(directory: string): string {
  const base = directory.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? ""
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .slice(0, 250)
    .replace(/^-+|-+$/g, "")

  return `${clean || "projeto"}.zip`
}

export function downloadProjectZip(filename: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes.slice().buffer], { type: "application/zip" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
