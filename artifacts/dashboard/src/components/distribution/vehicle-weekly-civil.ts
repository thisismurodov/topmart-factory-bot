import type { VehicleWeeklyDay } from "@workspace/api-client-react";

const DAY_MS = 86_400_000;

export function civilDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addCivilDays(value: string, days: number): string {
  return civilDate(
    new Date(new Date(`${value}T00:00:00Z`).getTime() + days * DAY_MS),
  );
}

export function currentTashkentMonday(now = Date.now()): string {
  const nowInUzbekistan = new Date(now + 5 * 60 * 60 * 1000);
  const civil = new Date(
    Date.UTC(
      nowInUzbekistan.getUTCFullYear(),
      nowInUzbekistan.getUTCMonth(),
      nowInUzbekistan.getUTCDate(),
    ),
  );
  const daysFromMonday = (civil.getUTCDay() + 6) % 7;
  return civilDate(new Date(civil.getTime() - daysFromMonday * DAY_MS));
}

export function isCivilMonday(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).getUTCDay() === 1
  );
}

export function formatCivilDate(value: string): string {
  return new Intl.DateTimeFormat("uz-UZ", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

export function formatCivilWeekRange(
  weekStart: string,
  weekEndExclusive: string,
): string {
  return `${formatCivilDate(weekStart)} — ${formatCivilDate(
    addCivilDays(weekEndExclusive, -1),
  )}`;
}

export function buildWeeklyCoverage(
  weekStart: string,
  requiredThroughDate: string,
  days: VehicleWeeklyDay[],
): Array<{
  date: string;
  day: VehicleWeeklyDay | undefined;
  futureNotRequired: boolean;
}> {
  const dayByDate = new Map(days.map((day) => [day.date, day]));
  return Array.from({ length: 7 }, (_, index) => {
    const date = addCivilDays(weekStart, index);
    const day = dayByDate.get(date);
    return {
      date,
      day,
      futureNotRequired: !day && date > requiredThroughDate,
    };
  });
}