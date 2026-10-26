/** Fixed lexicons keep feature extraction stable across profile versions. */
export const FUNCTION_WORDS =
  'the of and to a in that is was he for it with as his on be at by i this had not are but from or have an they which one you were her all she there would their we him been has when who will no more if'.split(
    ' ',
  );
export const CONTRACTIONS = new Set(
  "aren't can't couldn't didn't doesn't don't hadn't hasn't haven't he'd he'll he's i'd i'll i'm i've isn't it'd it'll it's let's mightn't mustn't needn't shan't she'd she'll she's shouldn't that's there's they'd they'll they're they've wasn't we'd we'll we're we've weren't what's where's who's won't wouldn't you'd you'll you're you've".split(
    ' ',
  ),
);
/** Small, self-authored neutral reference corpus. Not a population-level language frequency estimate. */
export const REFERENCE_TEXT = `The team will review the report and share the results with everyone. We need to consider the information before making a decision. This is an example of a short message about the project. Please let me know if you have any questions about the next steps. I will send the document when it is ready. Thank you for your time and help with this work. The meeting is scheduled for next week and we will discuss the plan. There are several options available for this task. It is important to understand how the system works. We can make changes to the process as needed.`;
