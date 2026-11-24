const SAME_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const CROSS_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatMessageTimestamp(createdAt: number, now: number = Date.now()) {
  if (!Number.isFinite(createdAt)) return '';
  return isSameLocalDay(new Date(createdAt), new Date(now))
    ? SAME_DAY_FORMATTER.format(createdAt)
    : CROSS_DAY_FORMATTER.format(createdAt).replace(',', '');
}

function isSameLocalDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}
