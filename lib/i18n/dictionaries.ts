export const LOCALES = ['en', 'ar'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_COOKIE = 'handle-locale'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALES.includes(value as Locale)
}

export function localeDir(locale: Locale) {
  return locale === 'ar' ? 'rtl' : 'ltr'
}

const en = {
  appName: 'Handle',
  language: {
    label: 'Language',
    switchTo: 'العربية',
    switchToLabel: 'التبديل إلى العربية (Switch to Arabic)',
    current: 'English',
  },
  auth: {
    signUpTitle: 'Claim your handle',
    signInTitle: 'Welcome back',
    signUpSubtitle:
      'Pick a username. Friends find you by it — no phone number needed.',
    signInSubtitle: 'Sign in with your username to continue chatting.',
    displayName: 'Display name',
    displayNamePlaceholder: 'Alex Rivera',
    username: 'Username',
    usernamePlaceholder: 'alex.rivera',
    usernameHint: '3–20 characters. Letters, numbers, dots and underscores.',
    password: 'Password',
    createAccount: 'Create account',
    creatingAccount: 'Creating account…',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    haveAccount: 'Already have a handle?',
    newHere: 'New here?',
    createAnAccount: 'Create an account',
    invalidUsername:
      'Usernames are 3–20 characters: lowercase letters, numbers, dots or underscores.',
    usernameTaken: 'That username is taken. Try another one.',
    signUpFailed:
      'Could not create your account. Please check your details and try again.',
    signInFailed: 'Incorrect username or password.',
  },
  chat: {
    signOut: 'Sign out',
    settings: 'Settings',
    emptyTitle: 'Your messages',
    emptyBody:
      "Pick a conversation, or start a new one by searching for someone's username.",
    loadError: "Couldn't load your conversations.",
    noConversations: 'No conversations yet',
    noConversationsBody:
      'Search for a username above to send your first message.',
    youPrefix: 'You: ',
    noMessagesYet: 'No messages yet',
    unread: (count: number) =>
      `${count} unread ${count === 1 ? 'message' : 'messages'}`,
    searchLabel: 'Find people by username',
    searchPlaceholder: 'Start a chat with @username',
    matchingPeople: 'Matching people',
    conversations: 'Conversations',
    back: 'Back to conversations',
    loadingMessages: 'Loading messages…',
    loadMessagesError: "Couldn't load messages.",
    sayHello: (name: string, username: string) =>
      `Say hello to ${name}. Messages are delivered to @${username}.`,
    messagesWith: (name: string) => `Messages with ${name}`,
    messageLabel: 'Message',
    messagePlaceholder: 'Type a message',
    send: 'Send message',
    sending: 'Sending',
    read: 'Read',
    delivered: 'Delivered',
    today: 'Today',
    yesterday: 'Yesterday',
    conversationFallback: 'Conversation',
  },
  errors: {
    USER_NOT_FOUND: 'No user with that username.',
    SELF_CHAT: "You can't start a chat with yourself.",
    INVALID_USERNAME: 'Enter a valid username.',
    EMPTY_MESSAGE: 'Message cannot be empty.',
    MESSAGE_TOO_LONG: 'Message is too long.',
    NAME_REQUIRED: 'Please enter a name.',
    NAME_TOO_LONG: 'Name must be 50 characters or fewer.',
    INVALID_IMAGE: 'Please choose a JPG, PNG or WebP image.',
    IMAGE_TOO_LARGE: 'That image is too large.',
    UNAUTHORIZED: 'Your session has ended. Please sign in again.',
    NOT_FOUND: 'Conversation not found.',
    GENERIC: 'Something went wrong. Please try again.',
  },
  settings: {
    title: 'Settings',
    back: 'Back to chats',
    profile: 'Profile',
    profileHint: 'This is how others see you in chats.',
    photo: 'Profile photo',
    changePhoto: 'Change photo',
    uploadPhoto: 'Upload photo',
    removePhoto: 'Remove photo',
    photoHint: 'JPG, PNG or WebP. It will be cropped to a square.',
    name: 'Display name',
    username: 'Username',
    usernameHint: 'Your username is permanent and is how people find you.',
    save: 'Save changes',
    saving: 'Saving…',
    saved: 'Saved',
    languageSection: 'Language',
    languageHint: 'Choose the language used across the app.',
    account: 'Account',
    accountHint: 'Sign out of Handle on this device.',
  },
}

export type Dictionary = typeof en

const ar: Dictionary = {
  appName: 'هاندل',
  language: {
    label: 'اللغة',
    switchTo: 'English',
    switchToLabel: 'Switch to English (التبديل إلى الإنجليزية)',
    current: 'العربية',
  },
  auth: {
    signUpTitle: 'احجز اسم المستخدم الخاص بك',
    signInTitle: 'مرحبًا بعودتك',
    signUpSubtitle:
      'اختر اسم مستخدم يجدك به أصدقاؤك — دون الحاجة إلى رقم هاتف.',
    signInSubtitle: 'سجّل الدخول باسم المستخدم لمتابعة المحادثة.',
    displayName: 'الاسم الظاهر',
    displayNamePlaceholder: 'أحمد علي',
    username: 'اسم المستخدم',
    usernamePlaceholder: 'ahmed.ali',
    usernameHint: 'من 3 إلى 20 حرفًا: أحرف إنجليزية وأرقام ونقاط وشرطات سفلية.',
    password: 'كلمة المرور',
    createAccount: 'إنشاء حساب',
    creatingAccount: 'جارٍ إنشاء الحساب…',
    signIn: 'تسجيل الدخول',
    signingIn: 'جارٍ تسجيل الدخول…',
    haveAccount: 'لديك حساب بالفعل؟',
    newHere: 'مستخدم جديد؟',
    createAnAccount: 'أنشئ حسابًا',
    invalidUsername:
      'يجب أن يتكوّن اسم المستخدم من 3 إلى 20 حرفًا: أحرف إنجليزية صغيرة أو أرقام أو نقاط أو شرطات سفلية.',
    usernameTaken: 'اسم المستخدم هذا مأخوذ. جرّب اسمًا آخر.',
    signUpFailed: 'تعذّر إنشاء حسابك. تحقق من بياناتك وحاول مرة أخرى.',
    signInFailed: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
  },
  chat: {
    signOut: 'تسجيل الخروج',
    settings: 'الإعدادات',
    emptyTitle: 'رسائلك',
    emptyBody: 'اختر محادثة، أو ابدأ محادثة جديدة بالبحث عن اسم مستخدم.',
    loadError: 'تعذّر تحميل محادثاتك.',
    noConversations: 'لا توجد محادثات بعد',
    noConversationsBody: 'ابحث عن اسم مستخدم في الأعلى لإرسال أول رسالة.',
    youPrefix: 'أنت: ',
    noMessagesYet: 'لا توجد رسائل بعد',
    unread: (count: number) => `${count} رسائل غير مقروءة`,
    searchLabel: 'ابحث عن الأشخاص باسم المستخدم',
    searchPlaceholder: 'ابدأ محادثة مع @اسم_المستخدم',
    matchingPeople: 'الأشخاص المطابقون',
    conversations: 'المحادثات',
    back: 'العودة إلى المحادثات',
    loadingMessages: 'جارٍ تحميل الرسائل…',
    loadMessagesError: 'تعذّر تحميل الرسائل.',
    sayHello: (name: string, username: string) =>
      `قل مرحبًا لـ ${name}. تصل الرسائل إلى @${username}.`,
    messagesWith: (name: string) => `الرسائل مع ${name}`,
    messageLabel: 'الرسالة',
    messagePlaceholder: 'اكتب رسالة',
    send: 'إرسال الرسالة',
    sending: 'جارٍ الإرسال',
    read: 'مقروءة',
    delivered: 'تم التسليم',
    today: 'اليوم',
    yesterday: 'أمس',
    conversationFallback: 'محادثة',
  },
  errors: {
    USER_NOT_FOUND: 'لا يوجد مستخدم بهذا الاسم.',
    SELF_CHAT: 'لا يمكنك بدء محادثة مع نفسك.',
    INVALID_USERNAME: 'أدخل اسم مستخدم صالحًا.',
    EMPTY_MESSAGE: 'لا يمكن إرسال رسالة فارغة.',
    MESSAGE_TOO_LONG: 'الرسالة طويلة جدًا.',
    NAME_REQUIRED: 'يرجى إدخال اسم.',
    NAME_TOO_LONG: 'يجب ألا يزيد الاسم على 50 حرفًا.',
    INVALID_IMAGE: 'يرجى اختيار صورة بصيغة JPG أو PNG أو WebP.',
    IMAGE_TOO_LARGE: 'الصورة كبيرة جدًا.',
    UNAUTHORIZED: 'انتهت جلستك. يرجى تسجيل الدخول مرة أخرى.',
    NOT_FOUND: 'المحادثة غير موجودة.',
    GENERIC: 'حدث خطأ ما. حاول مرة أخرى.',
  },
  settings: {
    title: 'الإعدادات',
    back: 'العودة إلى المحادثات',
    profile: 'الملف الشخصي',
    profileHint: 'هكذا يراك الآخرون في المحادثات.',
    photo: 'صورة الملف الشخصي',
    changePhoto: 'تغيير الصورة',
    uploadPhoto: 'رفع صورة',
    removePhoto: 'إزالة الصورة',
    photoHint: 'JPG أو PNG أو WebP. سيتم قصّها إلى شكل مربع.',
    name: 'الاسم الظاهر',
    username: 'اسم المستخدم',
    usernameHint: 'اسم المستخدم دائم، وبه يجدك الآخرون.',
    save: 'حفظ التغييرات',
    saving: 'جارٍ الحفظ…',
    saved: 'تم الحفظ',
    languageSection: 'اللغة',
    languageHint: 'اختر لغة واجهة التطبيق.',
    account: 'الحساب',
    accountHint: 'تسجيل الخروج من هاندل على هذا الجهاز.',
  },
}

export const dictionaries: Record<Locale, Dictionary> = { en, ar }

export type ErrorCode = keyof Dictionary['errors']

export function errorMessage(dict: Dictionary, code: unknown) {
  return typeof code === 'string' && code in dict.errors
    ? dict.errors[code as ErrorCode]
    : dict.errors.GENERIC
}
