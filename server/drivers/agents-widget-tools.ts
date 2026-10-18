// The two chat-widget tools of the agents catalog: definitions only, sent to the model on every turn.
export const WIDGET_TOOL_DEFINITIONS = [
  {
    name: "show_widget",
    description:
      "Show an interactive widget in this chat. Reach for it yourself, without being asked, whenever you need details from the person or are offering a choice: never ask them to type a date, a time, a length or one of a few options, in follow-ups too. To change something that exists, prefill its current values (defaultValue). \"Help me book a call\" gets a Card with a DatePicker, a TimePicker, a Select for the length and a Textarea for an optional note; \"remind me every weekday\" gets a TimePicker and a DayPicker. Also good for a confirmation, a live status or a short pick-one list. Data, comparisons and results go in a markdown table in your message instead, which the chat can copy and export. `widget` is one JSON tree. The root is {type:\"Card\"|\"ListView\", title?, caption?, children:[...], confirm?:{label,action}, cancel?:{label,action}}. Nodes: Row, Col, Box, Spacer, Divider, Text, Title, Caption, Markdown, Badge{label,color}, Icon{name}, Image{src}, Progress{value 0-1, or value and max}, Chart{data,series:[{type,dataKey}],xAxis}, Button{label,onClickAction}, Form{onSubmitAction,children}. Fields, each with a name and a short label: Select|RadioGroup{options:[{label,value}]}, DatePicker{min?,max?} (YYYY-MM-DD), TimePicker{min?,max?,step?} (HH:MM, 24-hour), DayPicker (days of the week, sent as \"mon,wed,fri\"), Checkbox, Input, Textarea. A ListView holds ListViewItem{children}; to have the person choose one row, give the ListView a name and each row a value, and confirm sends the pick. Select, RadioGroup and such a list also let the person type their own answer instead; set allowOther:false only when nothing but an option will do. An action is {type,payload?}; {type:\"open_url\",payload:{url}} opens a link. Labels are plain words, no emoji. When the person presses confirm, cancel or a button, their answers arrive as their next message, so end your turn after a widget that asks something. Keep it small: one confirm, one cancel, at most 8 rows. Never ask for passwords here. Not available in rooms.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        widget: { type: "object", additionalProperties: true, description: "The widget tree." },
        fallback_text: { type: "string", description: "Optional plain-text version for clients that cannot draw widgets. Written for you when omitted." },
      },
      required: ["widget"],
    },
  },
  {
    name: "update_widget",
    description:
      "Replace a widget you showed earlier in this chat, in place: a progress bar moving, a status changing. `widget_id` is the id show_widget returned. A widget the person already answered cannot be updated; show a new one.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        widget_id: { type: "string" },
        widget: { type: "object", additionalProperties: true },
      },
      required: ["widget_id", "widget"],
    },
  },
];
