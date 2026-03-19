import { describe, expect, it } from "vitest";

import { buildCompletedUserInputPrompt } from "../src/bridge/requests";

describe("user input request prompts", () => {
  it("renders completed answers with inline code formatting", () => {
    const answer = "Keep the diff small";

    expect(buildCompletedUserInputPrompt(answer)).toEqual({
      text: `User answered: ${answer}`,
      entities: [
        {
          type: "code",
          offset: "User answered: ".length,
          length: answer.length
        }
      ]
    });
  });
});
