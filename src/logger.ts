const RESET = "\x1b[0m";

const TAG_COLORS = [
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[32m", // green
  "\x1b[35m", // magenta
  "\x1b[34m", // blue
  "\x1b[90m", // bright black (gray)
  "\x1b[96m", // bright cyan
  "\x1b[93m", // bright yellow
  "\x1b[92m", // bright green
  "\x1b[95m", // bright magenta
  "\x1b[94m", // bright blue
  "\x1b[97m", // bright white
];

const LEVEL_COLORS: Readonly<Record<string, string>> = {
  error: "\x1b[31m", // red
  warn: "\x1b[33m",  // yellow
  info: "\x1b[37m",  // white
  debug: "\x1b[90m", // gray
};

function tagColorIndex(tag: string): number {
  let hash = 0;

  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) | 0;
  }

  return Math.abs(hash) % TAG_COLORS.length;
}

function shouldColorize(): boolean {
  return !process.env.NO_COLOR;
}

function colorize(text: string, color: string): string {
  if (!shouldColorize()) {
    return text;
  }

  return `${color}${text}${RESET}`;
}

function formatTag(tag: string): string {
  return colorize(`[${tag}]`, TAG_COLORS[tagColorIndex(tag)]);
}

function formatLevel(level: string): string {
  const color = LEVEL_COLORS[level];

  if (!color) {
    return level;
  }

  return colorize(level.toUpperCase(), color);
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export function createLogger(tag: string): Logger {
  const formattedTag = formatTag(tag);

  return {
    info(message: string): void {
      console.log(`${formattedTag} ${message}`);
    },
    warn(message: string): void {
      console.log(`${formattedTag} ${formatLevel("warn")} ${message}`);
    },
    error(message: string): void {
      console.log(`${formattedTag} ${formatLevel("error")} ${message}`);
    },
    debug(message: string): void {
      console.log(`${formattedTag} ${formatLevel("debug")} ${message}`);
    },
  };
}
