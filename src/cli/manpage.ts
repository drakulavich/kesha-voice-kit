import { defineCommand } from "citty";
// Inlined because import.meta.url escapes the embedded filesystem in the compiled .deb/.rpm binary (#914).
import manpage from "../../man/kesha.1" with { type: "text" };

export const manpageCommand = defineCommand({
  meta: {
    name: "manpage",
    description: "Print the kesha(1) manpage",
  },
  run() {
    process.stdout.write(manpage);
  },
});
