import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { consult } from "./src/advisor.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "advisor",
      label: "Advisor",
      description:
        "Request one independent second opinion for a concrete unresolved question. State purpose and supply evidence explicitly; no history or files are collected. Costs one model request. Do not use routinely or treat advice as approval. Optional provider/model overrides only this call.",
      parameters: Type.Object(
        {
          question: Type.String({
            minLength: 1,
            description: "The specific question to resolve",
          }),
          purpose: Type.Union([
            Type.Literal("decision"),
            Type.Literal("diagnosis"),
            Type.Literal("critique"),
          ]),
          context: Type.Optional(
            Type.String({
              description:
                "Explicit evidence, constraints, approach and uncertainty",
            }),
          ),
          model: Type.Optional(
            Type.String({ description: "provider/model; no fallback" }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: (_id, input, signal, _update, ctx) =>
        consult(input, ctx, getAgentDir(), signal),
    }),
  );
}
