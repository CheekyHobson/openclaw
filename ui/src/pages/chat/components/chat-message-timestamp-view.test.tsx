/* @vitest-environment jsdom */

import { For } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { ChatTimestamp } from "./chat-message-timestamp-view.tsx";

afterEach(() => vi.restoreAllMocks());

it("bounds calendar formatter construction across newly mounted history rows", () => {
  const Native = Intl.DateTimeFormat;
  const configured: Intl.DateTimeFormatOptions[] = [];
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
    if (options) {
      configured.push(options);
    }
    return new Native(locales ?? "en-GB-u-hc-h23", options);
  });
  const legacyDateTime = vi.spyOn(Date.prototype, "toLocaleString");
  const legacyDate = vi.spyOn(Date.prototype, "toLocaleDateString");
  const timestamps = Array.from({ length: 20 }, (_, index) => 1_000 + index * 60_000);
  const view = mountSolid(
    () => <For each={timestamps}>{(timestamp) => <ChatTimestamp timestamp={timestamp} />}</For>,
    {},
  );

  expect(view.container.querySelectorAll("time")).toHaveLength(20);
  expect(
    configured.length + legacyDateTime.mock.calls.length + legacyDate.mock.calls.length,
  ).toBeLessThanOrEqual(2);
  expect(configured.some((options) => options.weekday)).toBe(false);
});

it("uses fresh browser locale and time-zone defaults while preserving absolute strings", () => {
  const Native = Intl.DateTimeFormat;
  const nativeLocaleString = Date.prototype.toLocaleString;
  let locale = "en-US";
  let timeZone = "UTC";
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
    return new Native(locales ?? locale, { timeZone, ...options });
  });
  // Model browser defaults for Date's native formatting path as well as Intl.
  vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (
    this: Date,
    locales,
    options,
  ) {
    return nativeLocaleString.call(
      this,
      Array.isArray(locales) && locales.length === 0 ? locale : locales,
      {
        timeZone,
        ...options,
      },
    );
  });
  let timestamp = Date.UTC(2020, 0, 1);
  const view = mountSolid(
    (props: { timestamp: number }) => (
      <ChatTimestamp timestamp={props.timestamp} metadata={[<span>Context</span>]} />
    ),
    { timestamp },
  );
  const check = () => {
    const date = new Date(timestamp);
    expect(view.container.querySelector(".msg-meta__time")?.textContent).toBe(
      date.toLocaleString(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
        timeZone,
      }),
    );
    expect(view.container.querySelector("button")?.getAttribute("aria-label")).toBe(
      `Message context for ${date.toLocaleString(locale, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
        timeZone,
      })}`,
    );
    expect(view.container.querySelector("time")?.dateTime).toBe(date.toISOString());
  };
  check();
  timeZone = "America/Los_Angeles";
  timestamp += 1_000;
  view.update({ timestamp });
  check();
  locale = "de-DE";
  timestamp += 1_000;
  view.update({ timestamp });
  check();
});

it("keeps invalid timestamps readable without a calendar date", () => {
  const view = mountSolid(ChatTimestamp, { timestamp: Number.NaN });
  expect(view.container.querySelector("time")?.textContent).toBe("Unknown date");
  expect(view.container.querySelector("time")?.dateTime).toBe("");
});
