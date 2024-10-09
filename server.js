import fs from "fs";
import http from "http";
import dotenv from "dotenv";

// Load environment variables from the .env file
dotenv.config();

// Set up API URL, key, model, and streaming preferences from environment variables
const LLM_API_BASE_URL = process.env.LLM_API_BASE_URL || "https://api.groq.com/openai/v1";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
const LLM_CHAT_MODEL = process.env.LLM_CHAT_MODEL || "llama-3.1-8b-instant";
const LLM_STREAMING = process.env.LLM_STREAMING !== "no";

// Function to interact with the chat API
const chat = async (messages, handler) => {
  const url = `${LLM_API_BASE_URL}/chat/completions`; // API endpoint
  const auth = LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}; // Set up authorization header if API key is available
  const model = LLM_CHAT_MODEL; // Model to use for the chat completion
  const max_tokens = 400; // Maximum tokens for the response
  const temperature = 0; // Controls randomness of responses (lower = more deterministic)
  const stream = LLM_STREAMING && typeof handler === "function"; // Use streaming if handler is provided and streaming is enabled

  // Send a POST request to the chat API with the message payload
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      messages,
      model,
      max_tokens,
      temperature,
      stream,
    }),
  });

  // Throw an error if the response status is not OK
  if (!response.ok) {
    throw new Error(`HTTP error with the status: ${response.status} ${response.statusText}`);
  }

  // Handle non-streaming response case (regular completion)
  if (!stream) {
    const data = await response.json();
    const { choices } = data;
    const first = choices[0]; // Get the first choice in the response
    const { message } = first;
    const { content } = message;
    const answer = content.trim();
    handler && handler(answer); // If a handler is passed, send the response to the handler
    return answer;
  }

  // Function to parse streamed data lines from the API response
  const parse = (line) => {
    let partial = null;
    const prefix = line.substring(0, 6);
    if (prefix === "data: ") {
      const payload = line.substring(6); // Extract payload after the prefix
      try {
        const { choices } = JSON.parse(payload); // Parse JSON data
        const [choice] = choices;
        const { delta } = choice;
        partial = delta?.content; // Extract incremental content from the response
      } catch (e) {
        // Handle parsing errors silently
      } finally {
        return partial;
      }
    }
    return partial;
  };

  // Set up a reader to stream the API response and process it chunk by chunk
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let answer = "";
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    const lines = decoder.decode(value).split("\n");
    for (let i = 0; i < lines.length; ++i) {
      const line = buffer + lines[i];
      if (line[0] === ":") {
        buffer = ""; // Ignore comment lines
        continue;
      }
      if (line === "data: [DONE]") {
        break; // End of stream
      }
      if (line.length > 0) {
        const partial = parse(line); // Parse each line for valid content
        if (partial === null) {
          buffer = line;
        } else if (partial && partial.length > 0) {
          buffer = "";
          if (answer.length < 1) {
            const leading = partial.trim();
            answer = leading;
            handler && leading.length > 0 && handler(leading); // Send first part to handler
          } else {
            answer += partial;
            handler && handler(partial); // Send subsequent parts to handler
          }
        }
      }
    }
  }
  return answer; // Return the final answer after streaming is complete
};

// Prompt template for the assistant's behavior
const REPLY_PROMPT = `You are a helpful answering assistant.
Your task is to reply and respond to the user politely and concisely.
Answer in plain text (concisely, maximum 3 sentences) and not in Markdown format.`;

// Function to generate a reply based on the inquiry and previous conversation history
const reply = async (context) => {
  const { inquiry, history, stream } = context;

  const messages = [];
  messages.push({ role: "system", content: REPLY_PROMPT }); // System-level instructions for the assistant
  const relevant = history.slice(-4); // Take the last 4 interactions from the history
  relevant.forEach((msg) => {
    const { inquiry, answer } = msg;
    messages.push({ role: "user", content: inquiry });
    messages.push({ role: "assistant", content: answer });
  });
  messages.push({ role: "user", content: inquiry }); // Add the new inquiry
  const answer = await chat(messages, stream); // Get the chat completion from the API

  return { answer, ...context }; // Return the updated context with the new answer
};

// Server logic
(async () => {
  // Check if the API base URL is set, if not, exit the application
  if (!LLM_API_BASE_URL) {
    console.error("Fatal error: LLM_API_BASE_URL is not set!");
    process.exit(-1);
  }
  console.log(`Using LLM at ${LLM_API_BASE_URL} (model: ${LLM_CHAT_MODEL || "default"}).`);

  const history = []; // Initialize the conversation history

  // Create an HTTP server
  const server = http.createServer(async (request, response) => {
    const { url } = request;
    if (url === "/health") {
      // Health check endpoint
      response.writeHead(200).end("OK");
    } else if (url === "/" || url === "/index.html") {
      // Serve the index.html file
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(fs.readFileSync("./index.html"));
    } else if (url.startsWith("/chat")) {
      // Chat endpoint
      const parsedUrl = new URL(`http://localhost/${url}`);
      const { search } = parsedUrl;
      const inquiry = decodeURIComponent(search.substring(1)); // Extract and decode user inquiry from URL
      console.log("    Human:", inquiry);
      response.writeHead(200, { "Content-Type": "text/plain" });

      const stream = (part) => response.write(part); // Function to stream parts of the response
      const context = { inquiry, history, stream }; // Prepare context with inquiry and history
      const start = Date.now();
      const result = await reply(context); // Generate reply from the assistant
      const duration = Date.now() - start;
      response.end(); // End the HTTP response

      const { answer } = result;
      console.log("Assistant:", answer);
      console.log("       (in", duration, "ms)");
      console.log();
      history.push({ inquiry, answer, duration }); // Update conversation history
    } else {
      // Handle 404 error for unsupported routes
      console.error(`${url} is 404!`);
      response.writeHead(404);
      response.end();
    }
  });

  // Start the server on the configured port
  const port = process.env.PORT || 5900;
  server.listen(port);
  console.log("Listening on port", port);
})();
