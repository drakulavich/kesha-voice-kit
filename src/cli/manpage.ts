import { defineCommand } from "citty";

export const manpageCommand = defineCommand({
  meta: {
    name: "manpage",
    description: "Print the kesha(1) manpage",
  },
  async run() {
    const file = new URL("../../man/kesha.1", import.meta.url);
    process.stdout.write(await Bun.file(file).text());
  },
});
