const DURATION_PART = /^(\d+(?:\.\d+)?|\.\d+)([smhdw])/i
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/i

const DURATION_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)

function parseDuration(value: string, now: number): number | undefined {
  let remaining = value
  let duration = 0
  let parts = 0
  while (remaining) {
    const match = DURATION_PART.exec(remaining)
    if (!match) return undefined
    const unit = match[2]?.toLowerCase()
    if (!unit) return undefined
    const multiplier = DURATION_MS[unit]
    if (multiplier === undefined) return undefined
    duration += Number(match[1]) * multiplier
    if (!Number.isFinite(duration)) return undefined
    parts += 1
    remaining = remaining.slice(match[0].length).trimStart()
  }
  return parts > 0 && duration > 0 ? Math.ceil(now + duration) : undefined
}

function parseTimestamp(value: string): number | undefined {
  const match = ISO_TIMESTAMP.exec(value)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, , zone] = match
  const monthNumber = Number(month)
  const maxDay = monthNumber === 2 && isLeapYear(Number(year)) ? 29 : (MONTH_DAYS[monthNumber - 1] ?? 0)
  const valid =
    monthNumber >= 1 &&
    monthNumber <= 12 &&
    Number(day) >= 1 &&
    Number(day) <= maxDay &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second ?? "0") <= 59 &&
    zone !== undefined &&
    zone !== "-00:00" &&
    (zone.toUpperCase() === "Z" || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59))
  if (!valid) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parseWhen(input: string, now = Date.now()): number {
  const value = input.trim()
  const timestamp = parseDuration(value, now) ?? parseTimestamp(value)
  if (timestamp === undefined) {
    throw new Error("Use a positive duration such as 3h or 1h30m, or an ISO timestamp with a timezone.")
  }
  if (!Number.isFinite(now) || timestamp <= now) throw new Error("The time must be in the future.")
  if (!Number.isInteger(timestamp) || timestamp <= 0 || timestamp > 8_640_000_000_000_000) {
    throw new Error("The time is outside the supported date range.")
  }
  return timestamp
}
