// Times of day for the courtyard. Plain data shared by the store and the UI; the lighting for each lives
// in courtyardLighting.ts.

export type TimeOfDay = 'noon' | 'golden' | 'evening' | 'night';

export const TIMES_OF_DAY: readonly { id: TimeOfDay; label: string; hint: string }[] = [
  { id: 'noon', label: 'Noon', hint: 'High sun, lamps off (T)' },
  { id: 'golden', label: 'Golden', hint: 'Golden hour: low sun from the west (T)' },
  { id: 'evening', label: 'Evening', hint: 'After sunset: twilight sky, lamps on (T)' },
  { id: 'night', label: 'Night', hint: 'Lamps only (T)' },
];

export const DEFAULT_TIME_OF_DAY: TimeOfDay = 'golden';
