export function billingPeriod(activatedAt: Date, at: Date) {
  if (
    !Number.isFinite(activatedAt.getTime()) ||
    !Number.isFinite(at.getTime()) ||
    at < activatedAt
  )
    throw new Error('Invalid billing period date');
  const anchorMonth =
    activatedAt.getUTCFullYear() * 12 + activatedAt.getUTCMonth();
  let month = at.getUTCFullYear() * 12 + at.getUTCMonth();
  const boundary = (index: number) => {
    const year = Math.floor(index / 12);
    const monthOfYear = index % 12;
    const lastDay = new Date(Date.UTC(year, monthOfYear + 1, 0)).getUTCDate();
    return new Date(
      Date.UTC(
        year,
        monthOfYear,
        Math.min(activatedAt.getUTCDate(), lastDay),
        activatedAt.getUTCHours(),
        activatedAt.getUTCMinutes(),
        activatedAt.getUTCSeconds(),
        activatedAt.getUTCMilliseconds(),
      ),
    );
  };
  if (boundary(month) > at) month--;
  if (month < anchorMonth) throw new Error('Invalid billing period date');
  return { startsAt: boundary(month), endsAt: boundary(month + 1) };
}
