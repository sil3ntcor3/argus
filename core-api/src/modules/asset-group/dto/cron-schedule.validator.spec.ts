import { isValidCronSchedule } from './cron-schedule.validator';

describe('isValidCronSchedule', () => {
  it.each(['0 8 31 2 *', '0 8 30 2 *', '0 8 31 4 *'])(
    'rejects impossible schedule %s',
    (schedule) => {
      expect(isValidCronSchedule(schedule)).toBe(false);
    },
  );

  it.each(['0 8 29 2 *', '0 8 31 1 *', '0 8 * 1 *', '0 0 */3 * *', 'disabled'])(
    'accepts schedulable expression %s',
    (schedule) => {
      expect(isValidCronSchedule(schedule)).toBe(true);
    },
  );
});
