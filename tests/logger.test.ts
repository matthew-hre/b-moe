import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logger";

describe("createLogger", () => {
  test("creates a logger with info, warn, error, and debug methods", () => {
    const logger = createLogger("test");

    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  test("formats log messages with a colored tag prefix", () => {
    const originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      const logger = createLogger("my-module");
      logger.info("hello world");
      logger.warn("something off");
      logger.error("something broke");
      logger.debug("trace info");

      expect(logs).toEqual([
        "[my-module] hello world",
        "[my-module] WARN something off",
        "[my-module] ERROR something broke",
        "[my-module] DEBUG trace info",
      ]);
    } finally {
      console.log = originalLog;
      if (originalNoColor !== undefined) {
        process.env.NO_COLOR = originalNoColor;
      } else {
        delete process.env.NO_COLOR;
      }
    }
  });

  test("includes ANSI color codes when NO_COLOR is not set", () => {
    const originalNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      const logger = createLogger("my-module");
      logger.info("hello");

      expect(logs[0]).toContain("\x1b[");
      expect(logs[0]).toContain("[my-module]");
      expect(logs[0]).toContain("hello");
    } finally {
      console.log = originalLog;
      if (originalNoColor !== undefined) {
        process.env.NO_COLOR = originalNoColor;
      }
    }
  });

  test("uses different colors for different tags", () => {
    const originalNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      const loggerA = createLogger("module-a");
      const loggerB = createLogger("module-b");

      loggerA.info("from a");
      loggerB.info("from b");

      expect(logs[0]).not.toBe(logs[1]);
    } finally {
      console.log = originalLog;
      if (originalNoColor !== undefined) {
        process.env.NO_COLOR = originalNoColor;
      }
    }
  });
});
