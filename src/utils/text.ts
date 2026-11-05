const WHITESPACE = /\s/

export function splitFirstToken(input: string | undefined): [string, string] {
  const value = (input ?? "").trimStart()
  const boundary = value.search(WHITESPACE)
  return boundary < 0 ? [value, ""] : [value.slice(0, boundary), value.slice(boundary + 1).trimStart()]
}
