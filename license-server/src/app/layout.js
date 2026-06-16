import "./globals.css";

export const metadata = {
  title: "ByPass Ai — Licensing Hub & Admin Panel",
  description: "Secure, real-time license management and active session keys monitoring.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
