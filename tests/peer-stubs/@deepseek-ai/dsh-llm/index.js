/** Test stub for the optional dsh-llm peer: message constructors only. */
export function createSystemMessage(text) {
  return { role: 'system', content: String(text ?? '') };
}

export function createUserMessage(input) {
  return { role: 'user', ...input };
}
