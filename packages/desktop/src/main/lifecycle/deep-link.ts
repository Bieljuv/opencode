export function consoleReturnWindow(value: string) {
  try {
    const url = new URL(value)

    if (url.protocol !== "com.manostech.editor:") return
    // One slash after the scheme (`com.manostech.editor:/console/...`) puts
    // the path in `pathname`; the two-slash form keeps `console` as the host.
    // Both spell the same link, so normalize them before matching.
    const path = url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname

    if (path !== "/console/authorized") return
    const id = url.searchParams.get("window")

    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) return

    return id
  } catch {
    return
  }
}
