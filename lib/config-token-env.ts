export const updateConfigTokenEnv = (
  source: string,
  accessToken: string,
  refreshToken: string
) => {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source
    .split(/\r?\n/u)
    .filter(
      (line) =>
        !/^\s*(?:export\s+)?SLACK_APP_CONFIG_(?:REFRESH_)?TOKEN\s*=/u.test(line)
    );
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return [
    ...lines,
    `SLACK_APP_CONFIG_TOKEN=${JSON.stringify(accessToken)}`,
    `SLACK_APP_CONFIG_REFRESH_TOKEN=${JSON.stringify(refreshToken)}`,
    "",
  ].join(newline);
};
