# Baytree AI Gemini Classifier

Simple Express app that classifies text as one of three message types using the Gemini API.

## Endpoints

- `GET /` - health check
- `POST /classify` - classify a message

## Request body

```json
{
  "message": "Inquires only about hair colors, shades, or dyeing. Ignore price or stock."
}
```

## Response

```json
{
  "type": 1,
  "raw": "1"
}
```

## Setup

1. Copy `.env.example` to `.env`
2. Add your `GOOGLE_API_KEY` or `GEMINI_API_KEY`
3. Run `npm install`
4. Start with `npm start`

## Notes

- Type `1` is for hair color and dye-related questions.
- Type `2` is for whether extensions are safe/neutral for hair.
- Type `3` is for everything else.
