import { redirect } from 'next/navigation';

/** Home is My today (M11 Decision 9); the Dashboard (M12) is the overview. */
export default function HomePage() {
  redirect('/today');
}
