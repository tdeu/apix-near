import { NearProvider } from '../components/near/NearProvider';
export const metadata = { title: 'Agent shop' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><NearProvider>{children}</NearProvider></body></html>;
}
