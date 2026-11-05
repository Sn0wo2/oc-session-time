const DURATION_PART = /^(\d+(?:\.\d+)?|\.\d+)([smhdw])/i
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/i

export function parseWhen(input: string, now = Date.now()): number {
  const value = input.trim()
  let remaining = value
  let duration = 0
  let durationParts = 0
  let validDuration = true

  while (remaining) {
    const match = DURATION_PART.exec(remaining)
    const amountText = match?.[1]
    const unitText = match?.[2]?.toLowerCase()
    if (!match || amountText === undefined || unitText === undefined) {
      validDuration = false
      break
    }

    const amount = Number(amountText)
    if (!Number.isFinite(amount)) {
      validDuration = false
      break
    }

    let multiplier = 0
    switch (unitText) {
      case "s":
        multiplier = 1000
        break
      case "m":
        multiplier = 60_000
        break
      case "h":
        multiplier = 3_600_000
        break
      case "d":
        multiplier = 86_400_000
        break
      case "w":
        multiplier = 604_800_000
        break
      default:
        validDuration = false
        break
    }
    if (!validDuration) break

    duration += amount * multiplier
    if (!Number.isFinite(duration)) {
      validDuration = false
      break
    }
    durationParts += 1
    remaining = remaining.slice(match[0].length).trimStart()
  }

  let timestamp: number | undefined
  if (validDuration && durationParts > 0 && duration > 0) timestamp = Math.ceil(now + duration)
  else {
    const match = ISO_TIMESTAMP.exec(value)
    if (match) {
      const year = Number(match[1])
      const month = Number(match[2])
      const day = Number(match[3])
      const hour = Number(match[4])
      const minute = Number(match[5])
      const second = Number(match[6] ?? "0")
      const zone = match[8]
      const validCalendarDate =
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <=
          ([
            31,
            year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
            31,
            30,
            31,
            30,
            31,
            31,
            30,
            31,
            30,
            31,
          ][month - 1] ?? 0)

      if (validCalendarDate && hour <= 23 && minute <= 59 && second <= 59 && zone !== undefined && zone !== "-00:00") {
        const validZone =
          zone.toUpperCase() === "Z" || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59)
        if (validZone) {
          const parsed = Date.parse(value)
          timestamp = Number.isFinite(parsed) ? parsed : undefined
        }
      }
    }
  }

  if (timestamp === undefined) {
    throw new Error("Use a positive duration such as 3h or 1h30m, or an ISO timestamp with a timezone.")
  }
  if (!Number.isFinite(now) || timestamp <= now) throw new Error("The time must be in the future.")
  if (!Number.isInteger(timestamp) || timestamp <= 0 || timestamp > 8_640_000_000_000_000) {
    throw new Error("The time is outside the supported date range.")
  }

  return timestamp
}
