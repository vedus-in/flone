import {
  Body,
  Button,
  Column,
  Container,
  Font,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Tailwind,
  Text,
} from 'react-email';
import { PRODUCT_NAME, emailTailwindConfig } from './theme';

/**
 * The shell every message shares: boxed 640px container on a tinted page, a
 * two-column header, one or more rounded cards, and a footer.
 *
 * There is no logo image. The app ships no `public/` directory, and a remote
 * image that 404s renders as a broken-image icon in most clients -- worse than
 * the wordmark it would have replaced. If a logo is ever added, it goes here
 * once, not in nine templates.
 */

export function EmailFonts() {
  return (
    <Font
      fontFamily="Inter"
      fallbackFontFamily="Arial"
      webFont={{
        url: 'https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2',
        format: 'woff2',
      }}
      fontWeight={400}
      fontStyle="normal"
    />
  );
}

type EmailLayoutProps = {
  /** Inbox preview line. Always write one; clients otherwise scrape the body. */
  preview: string;
  /** Right side of the header: the organization, project, or product name. */
  context?: string;
  children: React.ReactNode;
};

export function EmailLayout({ preview, context, children }: EmailLayoutProps) {
  return (
    <Tailwind config={emailTailwindConfig}>
      <Html lang="en">
        <Head>
          <EmailFonts />
        </Head>

        <Body className="bg-bg-2 m-0 font-sans text-center">
          <Preview>{preview}</Preview>

          <Container className="mx-auto mt-8 mobile:mt-0 w-full max-w-[640px]">
            <Section className="bg-bg px-6 mobile:px-2 py-4">
              {/* Header */}
              <Section className="mb-3 px-6">
                <Row>
                  <Column className="py-[7px] w-1/2 align-middle">
                    <Text className="m-0 text-16 font-sans font-semibold text-fg text-left">
                      {PRODUCT_NAME}
                    </Text>
                  </Column>
                  <Column align="right" className="py-[7px] w-1/2 align-middle">
                    <Text className="m-0 text-13 font-sans text-right">
                      <span className="text-fg-3">{context ?? PRODUCT_NAME}</span>
                    </Text>
                  </Column>
                </Row>
              </Section>

              {children}

              {/* Footer */}
              <Section className="bg-bg">
                <Row>
                  <Column className="px-6 py-10 text-center">
                    <Text className="mx-auto mt-0 mb-6 max-w-[320px] text-13 font-sans text-fg-3 text-center">
                      {PRODUCT_NAME} keeps your team&apos;s issues, projects and cycles in one
                      place.
                    </Text>
                    <Text className="m-0 text-11 font-sans text-fg-3 text-center">
                      You are receiving this because of activity on your {PRODUCT_NAME} account.
                    </Text>
                  </Column>
                </Row>
              </Section>
            </Section>
          </Container>
        </Body>
      </Html>
    </Tailwind>
  );
}

/** One rounded panel. Every message is one or two of these. */
export function Card({ children }: { children: React.ReactNode }) {
  return (
    <Section className="bg-bg-2 mb-6 mobile:mb-2 px-5 mobile:px-4 pt-5 mobile:pt-4 pb-14 mobile:pb-10 rounded-[10px]">
      <Section className="mx-auto max-w-[440px] px-1 text-center">{children}</Section>
    </Section>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <Text className="mt-0 mb-6 text-13 font-sans text-fg-3 text-center">{children}</Text>
  );
}

export function Title({ children }: { children: React.ReactNode }) {
  return (
    <Heading as="h1" className="mt-0 mb-6 text-32 font-sans font-semibold text-fg text-center">
      {children}
    </Heading>
  );
}

export function Paragraph({ children }: { children: React.ReactNode }) {
  return (
    <Text className="mt-0 mb-6 text-16 font-sans text-fg-2 text-center">{children}</Text>
  );
}

/**
 * The call to action. `Button` renders a padded table cell rather than an
 * `<a>` with padding, because Outlook drops padding on inline anchors.
 */
export function Action({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Section className="mt-8 text-center">
      <Button
        href={href}
        className="inline-block bg-brand px-7 py-4 rounded-lg text-16 font-sans font-semibold text-fg-inverted text-center leading-6"
      >
        {children}
      </Button>
    </Section>
  );
}

/**
 * The link repeated as text under the button.
 *
 * Not decoration: a one-time link that only exists inside a button is
 * unrecoverable for anyone whose client strips the button, and "paste this into
 * your browser" is the standard escape hatch.
 */
export function FallbackLink({ href, note }: { href: string; note?: string }) {
  return (
    <Section className="mt-8 text-center">
      {note ? (
        <Text className="mt-0 mb-2 text-13 font-sans text-fg-3 text-center">{note}</Text>
      ) : null}
      <Text className="m-0 text-13 font-sans text-fg-3 text-center break-all">
        <Link href={href} className="text-brand-strong underline">
          {href}
        </Link>
      </Text>
    </Section>
  );
}

/** Small print under the action: expiry, "ignore this if it wasn't you". */
export function Note({ children }: { children: React.ReactNode }) {
  return (
    <Text className="mx-auto mt-8 mb-0 max-w-[400px] text-13 font-sans text-fg-3 text-center">
      {children}
    </Text>
  );
}

/**
 * A quoted body -- a comment, an issue description. Left-aligned inside the
 * otherwise centred card, because prose is not centred.
 */
export function Quote({ children }: { children: React.ReactNode }) {
  return (
    <Section className="bg-quote mt-6 mb-2 px-5 py-4 rounded-lg">
      <Text className="m-0 text-16 font-sans text-fg-2 text-left whitespace-pre-line">
        {children}
      </Text>
    </Section>
  );
}

/** `ENG-42 · Fix the flaky import` style metadata line. */
export function Meta({ children }: { children: React.ReactNode }) {
  return (
    <Text className="mt-0 mb-2 text-13 font-sans text-fg-3 text-left">{children}</Text>
  );
}
