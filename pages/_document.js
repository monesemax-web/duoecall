import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="icon" href="/favicon.png" type="image/png" />
        <link rel="icon" href="/logo-mark.svg" type="image/svg+xml" />
        <meta name="theme-color" content="#0f1216" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
