/**
 * A disposable, in-process SMTP server for tests (Phase 1.27 correction).
 *
 * Bound to 127.0.0.1 on an ephemeral port. It connects to nothing, relays
 * nothing, and delivers nothing — it speaks just enough SMTP for the real
 * Nodemailer client to authenticate and submit one message, which it keeps in
 * memory. The shape follows AgentNet Portal's `src/test/smtp-server.ts`, plus the
 * two things Monacado's adapter needs proved: `AUTH PLAIN` against a known
 * credential, and a scripted failure at a named stage so a transient refusal can
 * be driven through the real client.
 *
 * It advertises no STARTTLS, so the adapter must be configured with
 * `MONACADO_SMTP_REQUIRE_TLS=false` — which the configuration accepts only for a
 * loopback host.
 */

import net from "node:net";

export type FakeSmtpStage = "MAIL" | "RCPT" | "DATA";

export interface FakeSmtpMessage {
  mailFrom: string;
  rcptTo: string[];
  /** The DATA section, dot-unstuffed, lines joined with CRLF. */
  data: string;
}

export interface FakeSmtpServer {
  host: "127.0.0.1";
  port: number;
  messages: FakeSmtpMessage[];
  authentications: { accepted: number; refused: number };
  /** Queue one reply for the next time `stage` is reached. Consumed once. */
  failNext(stage: FakeSmtpStage, reply: string): void;
  close(): Promise<void>;
}

export async function startFakeSmtpServer(credential: {
  username: string;
  password: string;
}): Promise<FakeSmtpServer> {
  const messages: FakeSmtpMessage[] = [];
  const authentications = { accepted: 0, refused: 0 };
  const failures: Array<{ stage: FakeSmtpStage; reply: string }> = [];
  const sockets = new Set<net.Socket>();

  const takeFailure = (stage: FakeSmtpStage): string | undefined => {
    const index = failures.findIndex((f) => f.stage === stage);
    if (index === -1) return undefined;
    return failures.splice(index, 1)[0]!.reply;
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");

    let buffer = "";
    let authed = false;
    let awaitingAuthPlain = false;
    let inData = false;
    let mailFrom = "";
    let rcptTo: string[] = [];
    let dataLines: string[] = [];

    const reply = (line: string) => socket.write(`${line}\r\n`);

    const checkPlain = (encoded: string) => {
      const [, user, pass] = Buffer.from(encoded, "base64").toString("utf8").split("\u0000");
      if (user === credential.username && pass === credential.password) {
        authed = true;
        authentications.accepted += 1;
        reply("235 2.7.0 Authentication successful");
      } else {
        authentications.refused += 1;
        reply("535 5.7.8 Username and Password not accepted");
      }
    };

    const onLine = (line: string) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          const failure = takeFailure("DATA");
          if (failure !== undefined) {
            reply(failure);
          } else {
            messages.push({ mailFrom, rcptTo, data: dataLines.join("\r\n") });
            reply(`250 2.0.0 Ok: queued as FAKE${messages.length}`);
          }
          dataLines = [];
          return;
        }
        dataLines.push(line.startsWith("..") ? line.slice(1) : line);
        return;
      }

      if (awaitingAuthPlain) {
        awaitingAuthPlain = false;
        checkPlain(line.trim());
        return;
      }

      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO")) {
        socket.write("250-fake-smtp.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
      } else if (upper.startsWith("HELO")) {
        reply("250 fake-smtp.test");
      } else if (upper.startsWith("AUTH PLAIN")) {
        const initial = line.slice("AUTH PLAIN".length).trim();
        if (initial === "") {
          awaitingAuthPlain = true;
          reply("334 ");
        } else {
          checkPlain(initial);
        }
      } else if (upper.startsWith("AUTH")) {
        reply("504 5.5.4 Unrecognized authentication type");
      } else if (upper.startsWith("MAIL FROM")) {
        if (!authed) return reply("530 5.7.0 Authentication Required");
        const failure = takeFailure("MAIL");
        if (failure !== undefined) return reply(failure);
        mailFrom = line.slice(line.indexOf(":") + 1).trim();
        rcptTo = [];
        reply("250 2.1.0 Ok");
      } else if (upper.startsWith("RCPT TO")) {
        const failure = takeFailure("RCPT");
        if (failure !== undefined) return reply(failure);
        rcptTo.push(line.slice(line.indexOf(":") + 1).trim());
        reply("250 2.1.5 Ok");
      } else if (upper.startsWith("DATA")) {
        inData = true;
        reply("354 End data with <CR><LF>.<CR><LF>");
      } else if (upper.startsWith("QUIT")) {
        reply("221 2.0.0 Bye");
        socket.end();
      } else {
        /* RSET, NOOP, and anything else. */
        reply("250 2.0.0 Ok");
      }
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        onLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\r\n");
      }
    });

    reply("220 fake-smtp.test ESMTP ready");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    host: "127.0.0.1",
    port,
    messages,
    authentications,
    failNext(stage, reply) {
      failures.push({ stage, reply });
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** One header's value from a submitted message, unfolded. */
export function smtpHeader(data: string, name: string): string | undefined {
  const head = data.split("\r\n\r\n")[0] ?? "";
  const unfolded = head.replace(/\r\n[ \t]+/g, " ");
  const prefix = `${name.toLowerCase()}:`;
  const line = unfolded.split("\r\n").find((l) => l.toLowerCase().startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

/** The decoded plain-text body of a single-part message. */
export function smtpTextBody(data: string): string {
  const split = data.indexOf("\r\n\r\n");
  const body = split === -1 ? "" : data.slice(split + 4);
  const encoding = (smtpHeader(data, "Content-Transfer-Encoding") ?? "7bit").toLowerCase();
  if (encoding === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (encoding === "quoted-printable") {
    const bytes = body
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  return body;
}
